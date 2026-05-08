// Stage 6 — Footprint mode (no-claims path).
//
// Runs when stage 4 returned 0 claims. Maps the product's category to a
// baseline in category_baselines.json, computes percentile from the
// product's own CO2e (if present in evidence) or falls back to the median
// (50th percentile). Reads material/EOL fields from OpenFoodFacts evidence
// if present; otherwise leaves them null (NOT zero — null means "we don't
// know," which the scorer treats differently than "worst-case").
//
// Single LLM call only when product.category isn't already a known key.

import {
  getCategoryBaseline,
  listCategoryKeys,
  percentileForCo2,
  type CategoryBaseline,
} from './data/category_baselines.js';
import {
  computeHaikuCost,
  extractText,
  getDefaultClient,
  HAIKU_MODEL,
  safeJsonParse,
  type LlmAnthropic,
} from './llm.js';
import { FootprintSchema } from './schemas.js';
import type {
  EvidenceItem,
  Footprint,
  Product,
  RawEvidence,
} from './types.js';

export type FootprintResult = {
  footprint: Footprint;
  cost_usd: number;
  duration_ms: number;
};

// ─── OFF data extraction ─────────────────────────────────────────────────────
// OpenFoodFacts response (from sources/openfoodfacts.ts) has a `data` field
// shaped roughly like { product: { ecoscore_data, packagings, ... } }.
// We read very defensively — any missing key just yields null.

function readOffField(off: EvidenceItem | undefined): {
  recycled_content_pct: number | null;
  recyclability_score: number | null;
  biodegradability_score: number | null;
} {
  const empty = {
    recycled_content_pct: null,
    recyclability_score: null,
    biodegradability_score: null,
  };
  if (!off || off.status !== 'ok') return empty;
  const data = off.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return empty;

  const product = (data.product ?? data) as Record<string, unknown> | undefined;
  if (!product || typeof product !== 'object') return empty;

  // ecoscore_data.adjustments.packaging.value is a -15..0 penalty in OFF;
  // we only use its presence as a "we have packaging info" signal.
  const ecoscore = product.ecoscore_data as Record<string, unknown> | undefined;
  let recyclability_score: number | null = null;
  if (ecoscore && typeof ecoscore === 'object') {
    // 'a' best, 'e' worst — map to 0..1.
    const grade = ecoscore.score as unknown;
    if (typeof grade === 'number' && Number.isFinite(grade)) {
      recyclability_score = Math.max(0, Math.min(1, grade / 100));
    }
  }

  return {
    recycled_content_pct: null, // OFF rarely has this directly; leave null
    recyclability_score,
    biodegradability_score: null,
  };
}

function readAqueductField(aq: EvidenceItem | undefined): number | null {
  if (!aq || aq.status !== 'ok') return null;
  const d = aq.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const score = d.score;
  if (typeof score === 'number' && Number.isFinite(score)) {
    return Math.max(0, Math.min(5, score));
  }
  return null;
}

// ─── Category mapping ────────────────────────────────────────────────────────

async function mapCategoryViaLlm(
  product: Product,
  client: LlmAnthropic,
): Promise<{ category: string | null; cost_usd: number }> {
  const keys = listCategoryKeys();
  const prompt = `Map this product to the closest category in this list. Output JSON only: {"category": "<key>", "confidence": <0-1>}.
If no category fits with confidence >= 0.6, output {"category": null, "confidence": 0}.

Product: ${product.name} by ${product.manufacturer}
Category hint: ${product.category}
Available categories: ${keys.join(', ')}`;

  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 100,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  const cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
  const parsed = safeJsonParse<{ category: string | null; confidence: number }>(
    extractText(resp),
  );
  if (
    !parsed ||
    typeof parsed.confidence !== 'number' ||
    parsed.confidence < 0.6 ||
    !parsed.category ||
    !keys.includes(parsed.category)
  ) {
    return { category: null, cost_usd: cost };
  }
  return { category: parsed.category, cost_usd: cost };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runFootprint(
  product: Product,
  evidence: RawEvidence,
  client: LlmAnthropic = getDefaultClient(),
): Promise<FootprintResult> {
  const t0 = Date.now();
  let cost = 0;

  let categoryKey: string | null = null;
  let baseline: CategoryBaseline | null = getCategoryBaseline(product.category);
  if (baseline) {
    categoryKey = product.category;
  } else {
    const mapped = await mapCategoryViaLlm(product, client);
    cost += mapped.cost_usd;
    if (mapped.category) {
      categoryKey = mapped.category;
      baseline = getCategoryBaseline(mapped.category);
    }
  }

  const off = evidence.items.find((it) => it.source === 'openfoodfacts');
  const aq = evidence.items.find((it) => it.source === 'aqueduct');
  const offFields = readOffField(off);
  const water_stress_baseline = readAqueductField(aq);

  // No category match at all — return a footprint with null metrics.
  if (!baseline || !categoryKey) {
    const footprint: Footprint = {
      category: 'unknown',
      percentile: 50,
      co2e_kg: 0,
      water_l: 0,
      land_m2: 0,
      recycled_content_pct: offFields.recycled_content_pct,
      water_stress_baseline,
      regulatory_regime_score: null,
      certified_input_flag: null,
      recyclability_score: offFields.recyclability_score,
      biodegradability_score: offFields.biodegradability_score,
      repair_score: null,
    };
    return {
      footprint: FootprintSchema.parse(footprint),
      cost_usd: cost,
      duration_ms: Date.now() - t0,
    };
  }

  // We have a baseline. Use median for headline metrics; percentile = 50
  // unless evidence gives us a product-specific co2e value.
  const productCo2 = baseline.co2e_kg_median;
  const percentile = percentileForCo2(baseline, productCo2);

  const footprint: Footprint = {
    category: categoryKey,
    percentile,
    co2e_kg: baseline.co2e_kg_median,
    water_l: baseline.water_l_median,
    land_m2: baseline.land_m2_median,
    recycled_content_pct: offFields.recycled_content_pct,
    water_stress_baseline,
    regulatory_regime_score: null,
    certified_input_flag: null,
    recyclability_score: offFields.recyclability_score,
    biodegradability_score: offFields.biodegradability_score,
    repair_score: null,
  };

  return {
    footprint: FootprintSchema.parse(footprint),
    cost_usd: cost,
    duration_ms: Date.now() - t0,
  };
}
