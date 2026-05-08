// Typed accessor over category_baselines.json. Used by stage 6 (footprint mode)
// to compute headline metrics + percentile from a category key.

import baselinesJson from './category_baselines.json' with { type: 'json' };

export type CategoryBaseline = {
  co2e_kg_median: number;
  co2e_kg_p10: number;
  co2e_kg_p90: number;
  water_l_median: number;
  land_m2_median: number;
  _source: string;
};

const baselines = baselinesJson as Record<string, unknown>;

export function getCategoryBaseline(category: string): CategoryBaseline | null {
  if (category.startsWith('_')) return null;
  const v = baselines[category];
  if (!v || typeof v !== 'object') return null;
  // Trust the json structure — it's checked into the repo. _meta entries are filtered above.
  return v as CategoryBaseline;
}

export function listCategoryKeys(): string[] {
  return Object.keys(baselines).filter((k) => !k.startsWith('_'));
}

/**
 * Linear-interpolate `value` against the p10/median/p90 markers and return
 * a percentile in [0, 100]. P10 → 10, median → 50, P90 → 90, clamped at edges.
 * Higher CO2 = worse, so percentile here is "how bad" — the stage 8 sub-score
 * inverts it.
 */
export function percentileForCo2(
  baseline: CategoryBaseline,
  value: number,
): number {
  const { co2e_kg_p10: p10, co2e_kg_median: p50, co2e_kg_p90: p90 } = baseline;
  if (value <= p10) return 10;
  if (value >= p90) return 90;
  if (value <= p50) {
    // 10..50 mapped from p10..p50
    return 10 + ((value - p10) / (p50 - p10)) * 40;
  }
  // 50..90 mapped from p50..p90
  return 50 + ((value - p50) / (p90 - p50)) * 40;
}
