// Shared specialist runner. All six specialists differ only in their
// audit_type label and the standard they cite — the call shape, prompt
// scaffolding, parsing, and failure-mode handling are identical.
//
// Failure mode contract: if anything goes wrong (LLM error, malformed JSON,
// schema rejection), produce a synthetic SpecialistOutput with verdict
// INSUFFICIENT_EVIDENCE and an empty rebuttal_source_url. Stage 7's honesty
// gate will cleanly downgrade it. Defense in depth: schema, then runtime.

import {
  computeHaikuCost,
  extractText,
  getDefaultClient,
  HAIKU_MODEL,
  safeJsonParse,
  type LlmAnthropic,
} from '../llm.js';
import { RawSpecialistOutputSchema } from '../schemas.js';
import type { Claim, EvidenceItem, SpecialistOutput } from '../types.js';

const DEBUG = process.env.PIPELINE_DEBUG === '1';
function dlogReject(...args: unknown[]): void {
  if (DEBUG) console.error('[specialist:base:rejected]', ...args);
}
function dlogAccept(...args: unknown[]): void {
  if (DEBUG) console.error('[specialist:base:accepted]', ...args);
}
function dlogRetry(...args: unknown[]): void {
  if (DEBUG) console.error('[specialist:base:retry]', ...args);
}

// Exponential backoff retry on Anthropic 429 (rate limit) / 529 (overloaded).
// Caps at 3 attempts (initial + 2 retries with 2s, 4s sleeps). Anything else
// — schema validation errors, 4xx client errors, network errors — is not
// retryable: failing fast lets the synthetic INSUFFICIENT placeholder fire
// quickly rather than wasting seconds on a doomed call.
//
// Sleep helper is overridable so tests can swap in a fake.
const RETRYABLE_STATUSES = new Set<number>([429, 529]);
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;

let sleepFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/** Internal hook for tests — replace the sleep implementation. */
export function __setRetrySleep(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

/** Internal hook for tests — restore real timers. */
export function __resetRetrySleep(): void {
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status =
        (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      const retryable = status !== undefined && RETRYABLE_STATUSES.has(status);
      if (!retryable || attempt === MAX_RETRY_ATTEMPTS) throw err;
      const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      dlogRetry(
        `${context} attempt=${attempt} status=${status} backoff_ms=${backoffMs}`,
      );
      await sleepFn(backoffMs);
    }
  }
  throw lastErr;
}

export type SpecialistResult = {
  output: SpecialistOutput;
  cost_usd: number;
  duration_ms: number;
};

export type SpecialistConfig = {
  audit_type: string;
  standard_name: string;
};

const RULES = `Rules:
1. Cite the EXACT provision violated or satisfied. Use full notation (e.g. "FTC Green Guides §260.5(a)").
2. Output verdict ∈ {VERIFIED, FAILED, CONTRADICTED_BY_PRIMARY, INSUFFICIENT_EVIDENCE}.
3. If the evidence provided does not DIRECTLY address the claim, output INSUFFICIENT_EVIDENCE. Do NOT speculate. Do NOT generalize.
4. The rebuttal_source_url MUST be a URL present in the evidence input. Never invent URLs.
5. Quote the rebuttal source verbatim, max 50 words.`;

const SYNTHETIC_INSUFFICIENT: SpecialistOutput = {
  verdict_type: 'INSUFFICIENT_EVIDENCE',
  provision_cited: 'output validation failed',
  rebuttal_quote: '',
  rebuttal_source_url: '',
  rebuttal_source_tier: 5,
  reasoning: 'specialist output failed schema validation',
};

function serializeEvidence(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) {
    return '(no evidence available for this claim type)';
  }
  return evidence
    .map((it, i) => {
      const url = it.url ?? '(no url)';
      const data = typeof it.data === 'string' ? it.data : JSON.stringify(it.data);
      const truncated = data.length > 1500 ? data.slice(0, 1500) + '... [truncated]' : data;
      return `[${i + 1}] source=${it.source} tier=${it.tier} status=${it.status} url=${url}\n${truncated}`;
    })
    .join('\n\n');
}

export async function runSpecialist(
  config: SpecialistConfig,
  claim: Claim,
  evidence: EvidenceItem[],
  client: LlmAnthropic = getDefaultClient(),
): Promise<SpecialistResult> {
  const t0 = Date.now();

  const system = `You audit ${config.audit_type} environmental claims against ${config.standard_name}.\n\n${RULES}`;

  const user = `Claim: ${claim.quote}
Source URL: ${claim.source_url}
Type: ${claim.type_hint}

Available evidence:
${serializeEvidence(evidence)}

Respond in JSON only:
{
  "verdict": "...",
  "provision_cited": "...",
  "rebuttal_quote": "...",
  "rebuttal_source_url": "...",
  "rebuttal_source_tier": <integer 1-5>,
  "reasoning": "max 60 words"
}`;

  let cost = 0;
  let parsed: unknown;
  let rawText = '';

  try {
    const resp = await callWithRetry(
      () =>
        client.messages.create({
          model: HAIKU_MODEL,
          max_tokens: 600,
          temperature: 0,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      `specialist=${config.audit_type} claim=${claim.id}`,
    );
    cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
    rawText = extractText(resp);
    parsed = safeJsonParse(rawText);
  } catch (e) {
    dlogReject(
      `specialist=${config.audit_type} claim=${claim.id} reason=llm_call_threw error="${(e as Error).message}"`,
    );
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  if (!parsed) {
    dlogReject(
      `specialist=${config.audit_type} claim=${claim.id} reason=json_parse_failed raw_response=${JSON.stringify(rawText).slice(0, 2000)}`,
    );
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  const validated = RawSpecialistOutputSchema.safeParse(parsed);
  if (!validated.success) {
    // Build a per-issue trace including the offending value at each path.
    const issues = validated.error.issues.map((iss) => {
      const pathStr = iss.path.join('.');
      let valuePreview = '<unreadable>';
      try {
        const v = (parsed as Record<string, unknown>)[pathStr] ?? (parsed as unknown);
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s !== undefined) {
          valuePreview =
            s.length > 220
              ? `"${s.slice(0, 100)}…[len=${s.length}]…${s.slice(-100)}"`
              : s;
        }
      } catch {
        // leave preview as <unreadable>
      }
      return `path=${pathStr || '(root)'} code=${iss.code} message="${iss.message}" value=${valuePreview}`;
    });
    dlogReject(
      `specialist=${config.audit_type} claim=${claim.id} reason=schema_rejected\n  issues:\n    ${issues.join('\n    ')}\n  full_raw_response=${JSON.stringify(rawText)}`,
    );
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  const v = validated.data;
  dlogAccept(
    `specialist=${config.audit_type} claim=${claim.id} verdict=${v.verdict} tier=${v.rebuttal_source_tier} url=${v.rebuttal_source_url}`,
  );
  return {
    output: {
      verdict_type: v.verdict,
      provision_cited: v.provision_cited,
      rebuttal_quote: v.rebuttal_quote,
      rebuttal_source_url: v.rebuttal_source_url,
      rebuttal_source_tier: v.rebuttal_source_tier,
      reasoning: v.reasoning,
    },
    cost_usd: cost,
    duration_ms: Date.now() - t0,
  };
}

export const INSUFFICIENT_FALLBACK = SYNTHETIC_INSUFFICIENT;
