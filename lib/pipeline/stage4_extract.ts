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

Brand pages often present claims as short bullets, badges, certification mentions, or one-line headers (e.g. "Fair Trade Certified", "100% recycled polyester", "B Corp since 2012", "Carbon neutral by 2030"). These all count as claims if they make a specific environmental, sustainability, climate, recycling, sourcing, or emissions assertion about the product or manufacturer. Do not require full sentences. Treat each bullet, badge, or short header as its own candidate claim.

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
Output JSON only. No prose, no markdown fences.

EXAMPLE 1 — verbose ESG paragraph yielding 1 claim
Input:
"Our 2030 sustainability strategy commits us to source 100% of our cotton from regenerative farms by the end of the decade, an ambitious target that builds on years of investment in supplier programs."

Output:
[{"id":"claim-1","quote":"source 100% of our cotton from regenerative farms by the end of the decade","type_hint":"factual","source_url":"<source>"}]

EXAMPLE 2 — bulleted product page yielding 3 claims
Input:
"• Fair Trade Certified sewing
• Made with recycled polyester
• 1% for the Planet member since 1985"

Output:
[
  {"id":"claim-1","quote":"Fair Trade Certified sewing","type_hint":"certification","source_url":"<source>"},
  {"id":"claim-2","quote":"Made with recycled polyester","type_hint":"qualitative","source_url":"<source>"},
  {"id":"claim-3","quote":"1% for the Planet member since 1985","type_hint":"certification","source_url":"<source>"}
]`;

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
