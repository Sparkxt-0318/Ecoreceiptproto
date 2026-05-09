// Stage 4 — Environmental claim extraction from brand marketing copy.
//
// Single Haiku-4-5 call. Only fires when brand_site evidence is `ok` with
// non-empty content. Empty content → return [] immediately and route to
// stage 6 (footprint mode).
//
// Failure modes are explicit: the LLM emitting non-JSON, an array element
// failing the schema, a missing claim id — any of these reduce the entire
// extraction to []. Better to lose claims than to feed garbage to the
// specialists. Stage 6 picks up the no-claims path cleanly.

import crypto from 'node:crypto';

import {
  ClaimSchema,
  RawClaimsArraySchema,
} from './schemas.js';
import {
  computeHaikuCost,
  extractText,
  getDefaultClient,
  HAIKU_MODEL,
  safeJsonParse,
  type LlmAnthropic,
} from './llm.js';
import type { Claim, Product } from './types.js';

const DEBUG = process.env.PIPELINE_DEBUG === '1';
function dlog(...args: unknown[]): void {
  if (DEBUG) console.error('[stage4:extract]', ...args);
}

const SYSTEM_PROMPT = `You extract environmental claims from brand marketing copy.

ONLY extract claims that explicitly state environmental, sustainability, climate, recycling, sourcing, or emissions properties of THIS product or its manufacturer.

DO NOT extract:
- Generic marketing language ("premium", "high quality", "best")
- Health claims unrelated to environment ("low fat", "organic" only if used as health rather than environmental claim)
- Vague aspirational statements without product-specific reference ("we believe in a better future")

For each claim, classify type_hint:
- "quantitative": contains a specific number or percentage (e.g. "70% recycled materials")
- "qualitative": uses fuzzy environmental terms without numbers (e.g. "eco-friendly", "natural", "sustainable")
- "certification": names or shows a certification (e.g. "FSC certified", "USDA Organic", "B Corp")
- "disclosure": about emissions, carbon footprint, or climate reporting (e.g. "carbon neutral", "net zero by 2030")
- "comparison": comparing to a baseline (e.g. "30% less plastic than before")
- "factual": specific operational claim about facility, sourcing, or ingredient (e.g. "tomatoes sourced from California")

Output JSON array. Each claim:
{
  "id": "claim-<n>",
  "quote": "verbatim text from source",
  "type_hint": "...",
  "source_url": "<source_url_passed_in>"
}

If no environmental claims exist, return [].
Output JSON only. No prose, no markdown fences.`;

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export type ExtractClaimsResult = {
  claims: Claim[];
  cost_usd: number;
  duration_ms: number;
};

export async function extractClaims(
  product: Product,
  brandSiteContent: string,
  brandSiteUrl: string,
  client: LlmAnthropic = getDefaultClient(),
): Promise<ExtractClaimsResult> {
  const t0 = Date.now();

  dlog(`product=${product.name} content_length=${brandSiteContent?.length ?? 0}`);
  dlog(`first_500_chars="${(brandSiteContent ?? '').slice(0, 500).replace(/\n/g, ' ')}"`);

  if (!brandSiteContent || brandSiteContent.trim().length === 0) {
    dlog('→ empty content, short-circuit returning []');
    return { claims: [], cost_usd: 0, duration_ms: 0 };
  }

  const userMessage = `Product: ${product.name} by ${product.manufacturer}
Source URL: ${brandSiteUrl}

Brand marketing copy:
${brandSiteContent}`;

  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
  const text = extractText(resp);
  const parsed = safeJsonParse<unknown>(text);

  if (parsed === null) {
    dlog(`→ JSON parse failed; raw_llm_response="${text.slice(0, 1000).replace(/\n/g, ' ')}"`);
    return { claims: [], cost_usd: cost, duration_ms: Date.now() - t0 };
  }

  const rawClaims = RawClaimsArraySchema.safeParse(parsed);
  if (!rawClaims.success) {
    dlog(`→ schema rejected; raw_parsed=${JSON.stringify(parsed).slice(0, 1000)}`);
    return { claims: [], cost_usd: cost, duration_ms: Date.now() - t0 };
  }

  const sourceHash = sha256(brandSiteContent);
  const retrievalDate = new Date().toISOString();

  const claims: Claim[] = [];
  for (const rc of rawClaims.data) {
    const candidate: Claim = {
      id: rc.id,
      quote: rc.quote,
      type_hint: rc.type_hint,
      source_url: rc.source_url,
      source_hash: sourceHash,
      retrieval_date: retrievalDate,
    };
    const v = ClaimSchema.safeParse(candidate);
    if (v.success) claims.push(v.data);
  }

  dlog(`→ returning ${claims.length} claim(s) (raw=${rawClaims.data.length})`);
  if (claims.length === 0 && rawClaims.data.length === 0) {
    dlog(`  raw_llm_response="${text.slice(0, 1000).replace(/\n/g, ' ')}"`);
  }

  return { claims, cost_usd: cost, duration_ms: Date.now() - t0 };
}
