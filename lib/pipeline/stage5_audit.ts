// Stage 5 — Six-specialist concurrency-capped audit + Stage 5b self-consistency.
//
// Maps each claim's type_hint to one specialist, dispatches with at most
// AUDIT_CONCURRENCY (3) in flight at once, stitches claim_ids onto the
// outputs, and runs the self-consistency check on any contra verdict that
// returned CONTRADICTED_BY_PRIMARY.
//
// Concurrency cap is the upstream half of rate-limit handling; the
// downstream half is the 429/529 retry-with-backoff inside specialists/base.
// Together they protect against Anthropic free-tier RPM stampedes that
// previously caused 71% specialist-rejection rates.
//
// Critical: only specialists for which there are matching claims actually
// fire. Empty claims of a given type_hint → that specialist never runs.

import type { LlmAnthropic } from './llm.js';
import { runSelfConsistencyCheck } from './stage5b_consistency.js';
import {
  buildCertEvidenceSlice,
  runCertSpecialist,
} from './specialists/cert.js';
import { runCompareSpecialist } from './specialists/compare.js';
import { runContraSpecialist } from './specialists/contra.js';
import { runQualifierSpecialist } from './specialists/qualifier.js';
import { runQuantSpecialist } from './specialists/quant.js';
import { runScopeSpecialist } from './specialists/scope.js';
import type { SpecialistResult } from './specialists/base.js';
import type {
  Claim,
  ClaimType,
  EvidenceItem,
  EvidenceSource,
  Product,
  RawEvidence,
  SpecialistOutput,
  Verdict,
} from './types.js';

// ─── Per-specialist evidence-slice configuration ─────────────────────────────

const EVIDENCE_FILTERS: Record<ClaimType, EvidenceSource[]> = {
  quantitative: ['brand_site', 'sec_edgar', 'epa_envirofacts', 'aqueduct'],
  qualitative: ['brand_site'],
  certification: ['brand_site'],
  disclosure: ['brand_site', 'sec_edgar'],
  comparison: ['brand_site', 'sec_edgar'],
  factual: ['epa_envirofacts', 'aqueduct', 'sec_edgar'],
};

function sliceEvidence(
  evidence: RawEvidence,
  sources: EvidenceSource[],
): EvidenceItem[] {
  return evidence.items.filter((it) => sources.includes(it.source));
}

// ─── Specialist dispatch table ───────────────────────────────────────────────

type SpecialistRunner = (
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
) => Promise<SpecialistResult>;

type SpecialistName =
  | 'quant'
  | 'qualifier'
  | 'cert'
  | 'scope'
  | 'compare'
  | 'contra';

type SpecialistTable = Record<SpecialistName, SpecialistRunner>;

const DEFAULT_TABLE: SpecialistTable = {
  quant: runQuantSpecialist,
  qualifier: runQualifierSpecialist,
  cert: runCertSpecialist,
  scope: runScopeSpecialist,
  compare: runCompareSpecialist,
  contra: runContraSpecialist,
};

const TYPE_TO_SPECIALIST: Record<ClaimType, SpecialistName> = {
  quantitative: 'quant',
  qualitative: 'qualifier',
  certification: 'cert',
  disclosure: 'scope',
  comparison: 'compare',
  factual: 'contra',
};

// ─── Public types ────────────────────────────────────────────────────────────

export type AuditResult = {
  verdicts: Verdict[];
  cost_usd: number;
  duration_ms: number;
};

export type AuditDeps = {
  client?: LlmAnthropic;
  /** Override individual specialists for testing. */
  specialists?: Partial<SpecialistTable>;
  /**
   * Product context — used by the cert specialist to look up known
   * certifications by manufacturer name. Optional for backwards
   * compatibility with tests that pre-date the cert-registry feature.
   */
  product?: Product;
};

// Cap on concurrent specialist dispatches. Tuned for the Anthropic free-tier
// 5 RPM Haiku ceiling (with 3 in flight, the 2-second per-call latency means
// we land roughly at 4-5 RPM — plus the 429 retry handles spillover).
const AUDIT_CONCURRENCY = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run `fn(item)` for each item with at most `limit` invocations in flight.
 * Returns results in input order. Rejections are surfaced — callers using
 * Promise.allSettled-style handling should wrap fn() to catch errors.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        const value = await fn(items[i]!);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function buildEvidenceForClaim(
  claim: Claim,
  evidence: RawEvidence,
  product?: Product,
): EvidenceItem[] {
  const sources = EVIDENCE_FILTERS[claim.type_hint];
  const sliced = sliceEvidence(evidence, sources);
  if (claim.type_hint === 'certification') {
    return buildCertEvidenceSlice(claim, sliced, product?.manufacturer);
  }
  return sliced;
}

function thrownVerdict(claimId: string, message: string): Verdict {
  return {
    claim_id: claimId,
    verdict_type: 'INSUFFICIENT_EVIDENCE',
    provision_cited: 'specialist execution failed',
    rebuttal_quote: '',
    rebuttal_source_url: '',
    rebuttal_source_tier: 5,
    reasoning: message.slice(0, 200),
    downgrade_reason: 'specialist threw',
  };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runAudit(
  claims: Claim[],
  evidence: RawEvidence,
  deps: AuditDeps = {},
): Promise<AuditResult> {
  const t0 = Date.now();
  if (claims.length === 0) {
    return { verdicts: [], cost_usd: 0, duration_ms: 0 };
  }

  const table: SpecialistTable = { ...DEFAULT_TABLE, ...(deps.specialists ?? {}) };

  type Dispatch = {
    claim: Claim;
    specialist: SpecialistName;
  };

  // Build lazy dispatch descriptors — promises are NOT created until each
  // task is actually picked up by the concurrency limiter. Eagerly creating
  // promises here would defeat the cap.
  const dispatches: Dispatch[] = claims.map((claim) => ({
    claim,
    specialist: TYPE_TO_SPECIALIST[claim.type_hint],
  }));

  const settled = await runWithConcurrency(
    dispatches,
    (d) => {
      const slice = buildEvidenceForClaim(d.claim, evidence, deps.product);
      return table[d.specialist](d.claim, slice, deps.client);
    },
    AUDIT_CONCURRENCY,
  );

  let totalCost = 0;
  const verdicts: Verdict[] = [];

  for (let i = 0; i < settled.length; i++) {
    const dispatch = dispatches[i]!;
    const result = settled[i]!;
    const claimId = dispatch.claim.id;

    if (result.status === 'rejected') {
      verdicts.push(
        thrownVerdict(
          claimId,
          (result.reason as Error)?.message ?? 'unknown specialist failure',
        ),
      );
      continue;
    }

    const { output, cost_usd } = result.value;
    totalCost += cost_usd;

    let verdict: Verdict = {
      claim_id: claimId,
      ...output,
    };

    // Stage 5b: self-consistency on contra contradictions only.
    if (
      dispatch.specialist === 'contra' &&
      verdict.verdict_type === 'CONTRADICTED_BY_PRIMARY'
    ) {
      const slice = buildEvidenceForClaim(dispatch.claim, evidence, deps.product);
      const reRun = async (): Promise<SpecialistOutput> => {
        const r = await table.contra(dispatch.claim, slice, deps.client);
        totalCost += r.cost_usd;
        return r.output;
      };
      verdict = await runSelfConsistencyCheck(verdict, reRun);
    }

    verdicts.push(verdict);
  }

  return {
    verdicts,
    cost_usd: totalCost,
    duration_ms: Date.now() - t0,
  };
}
