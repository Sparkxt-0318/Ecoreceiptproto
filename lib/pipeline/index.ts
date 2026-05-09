// EcoReceipt detection pipeline — main orchestrator.
//
// Stages execute in order, each accumulating cost + duration. Telemetry
// is emitted as a single console.info at the end. Failure modes:
//   - Stage 1 (resolve) throws InsufficientProductDataError → propagated.
//   - Any other stage error is caught and folded into the receipt as
//     INSUFFICIENT_EVIDENCE / confidence_grade='C'. Pipelines never
//     panic to the caller.
//
// Branching:
//   claims.length === 0 → run Stage 6 (footprint mode), verdicts=[]
//   claims.length >= 1  → run Stage 5 (audit), still compute footprint
//                         for the carbon/material/EOL sub-scores

import { getCached, setCached } from './cache.js';
import { getDefaultClient, type LlmAnthropic } from './llm.js';
import { resolveProduct, type ResolveDeps } from './stage1_resolve.js';
import {
  gatherEvidence,
  makeDefaultFetchers,
  type EvidenceFetchers,
} from './stage3_evidence.js';
import { extractClaims } from './stage4_extract.js';
import { runAudit } from './stage5_audit.js';
import { runFootprint } from './stage6_footprint.js';
import { validateTiers } from './stage7_validate.js';
import {
  computeEcoScore,
  computeStatusBadge,
  synthesizeScores,
} from './stage8_score.js';
import { computeConfidenceGrade } from './stage9_grade.js';
import { anchorReceipt } from './stage10_anchor.js';
import type {
  EcoReceipt,
  EvidenceItem,
  PipelineInput,
  StageTrace,
} from './types.js';

export type PipelineDeps = {
  client?: LlmAnthropic;
  resolveDeps?: ResolveDeps;
  fetchers?: EvidenceFetchers;
};

function findItem(
  items: EvidenceItem[],
  source: EvidenceItem['source'],
): EvidenceItem | undefined {
  return items.find((it) => it.source === source);
}

function brandSiteText(items: EvidenceItem[]): { text: string; url: string } {
  const item = findItem(items, 'brand_site');
  if (!item || item.status !== 'ok') return { text: '', url: '' };
  const data = item.data as { text?: string } | null;
  return { text: data?.text ?? '', url: item.url ?? '' };
}

export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps = {},
): Promise<EcoReceipt> {
  const startedAt = Date.now();
  const traces: StageTrace[] = [];
  const client = deps.client ?? getDefaultClient();
  let totalCost = 0;

  const trace = (
    stage: StageTrace['stage'],
    t0: number,
    cost: number,
    ok: boolean,
    note?: string,
  ): void => {
    traces.push({ stage, duration_ms: Date.now() - t0, cost_usd: cost, ok, note });
    totalCost += cost;
  };

  // ─── Stage 1 — resolve product ────────────────────────────────────────────
  const t1 = Date.now();
  const resolved = await resolveProduct(input, { client, ...deps.resolveDeps });
  trace('resolve', t1, resolved.cost_usd, true);
  const product = resolved.product;

  // ─── Stage 2 — cache check ────────────────────────────────────────────────
  const t2 = Date.now();
  const hit = getCached(product.id);
  trace('cache_check', t2, 0, true, hit ? 'hit' : 'miss');
  if (hit) {
    // eslint-disable-next-line no-console
    console.info('[runPipeline] cache hit', {
      duration_ms: Date.now() - startedAt,
      cost_usd: 0,
      stages: traces.length,
      badge: hit.status_badge,
      grade: hit.confidence_grade,
    });
    return hit;
  }

  // ─── Stage 3 — evidence ───────────────────────────────────────────────────
  // Pass the LLM client into the default fetchers so the brand_site fetcher
  // can synthesize a training-knowledge summary when every HTTP candidate
  // fails. (Stage 7 ensures fallback content can never be cited as a
  // rebuttal source, so this is safe to feed Stage 4.)
  const t3 = Date.now();
  const fetchers = deps.fetchers ?? makeDefaultFetchers(undefined, client);
  const evidence = await gatherEvidence(product, fetchers);
  trace('evidence', t3, 0, !evidence.degraded);

  // ─── Stage 4 — claim extraction ───────────────────────────────────────────
  const t4 = Date.now();
  const { text: brandText, url: brandUrl } = brandSiteText(evidence.items);
  const extraction = await extractClaims(product, brandText, brandUrl, client);
  trace('extract', t4, extraction.cost_usd, true, `${extraction.claims.length} claims`);

  // ─── Stages 5 + 6 — audit (with claims) and footprint (always) ────────────
  const t5 = Date.now();
  const audit = await runAudit(extraction.claims, evidence, { client, product });
  trace('audit', t5, audit.cost_usd, true);

  const t6 = Date.now();
  const footprintRes = await runFootprint(product, evidence, client);
  trace('footprint', t6, footprintRes.cost_usd, true);
  const footprint = footprintRes.footprint;

  // ─── Stage 7 — tier validator ─────────────────────────────────────────────
  const t7 = Date.now();
  const validatedVerdicts =
    extraction.claims.length === 0 ? [] : validateTiers(audit.verdicts, evidence);
  trace('validate', t7, 0, true);

  // ─── Stage 8 — synthesize sub-scores + ecoscore + badge ───────────────────
  const t8 = Date.now();
  const subScores = synthesizeScores(validatedVerdicts, footprint);
  const ecoscore = computeEcoScore(subScores);
  const statusBadge = computeStatusBadge(validatedVerdicts, subScores, ecoscore);
  trace('score', t8, 0, true);

  // ─── Stage 9 — confidence grade ───────────────────────────────────────────
  const t9 = Date.now();
  const confidenceGrade = computeConfidenceGrade(validatedVerdicts, evidence);
  trace('grade', t9, 0, true);

  // ─── Stage 10 — anchor + cache write ──────────────────────────────────────
  const t10 = Date.now();

  const receiptShell: EcoReceipt = {
    product,
    status_badge: statusBadge,
    ecoscore,
    sub_scores: subScores,
    headline_metrics: {
      co2e_kg: footprint.co2e_kg,
      water_l: footprint.water_l,
      land_m2: footprint.land_m2,
      category_percentile: footprint.percentile,
    },
    verdicts: validatedVerdicts,
    evidence_merkle_root: '',
    confidence_grade: confidenceGrade,
    generated_at: new Date().toISOString(),
    pipeline_duration_ms: Date.now() - startedAt,
    pipeline_cost_usd: totalCost,
  };
  const anchor = await anchorReceipt(receiptShell, evidence);
  const finalReceipt: EcoReceipt = {
    ...receiptShell,
    evidence_merkle_root: anchor.merkle_root,
    pipeline_duration_ms: Date.now() - startedAt,
    pipeline_cost_usd: totalCost,
  };
  trace('cache_write', t10, 0, true);

  setCached(product.id, finalReceipt);

  // eslint-disable-next-line no-console
  console.info('[runPipeline] complete', {
    duration_ms: finalReceipt.pipeline_duration_ms,
    cost_usd: finalReceipt.pipeline_cost_usd,
    stages: traces.length,
    badge: finalReceipt.status_badge,
    grade: finalReceipt.confidence_grade,
  });

  return finalReceipt;
}

// Re-exports so consumers can import everything from one module.
export { clearCache, getCached, setCached, isoWeek } from './cache.js';
export { InsufficientProductDataError } from './types.js';
export type {
  EcoReceipt,
  PipelineInput,
  Product,
  Verdict,
  StatusBadge,
  ConfidenceGrade,
} from './types.js';
