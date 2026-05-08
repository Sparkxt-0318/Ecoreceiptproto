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

  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 600,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    });
    cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
    parsed = safeJsonParse(extractText(resp));
  } catch {
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  if (!parsed) {
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  const validated = RawSpecialistOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      output: SYNTHETIC_INSUFFICIENT,
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  const v = validated.data;
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
