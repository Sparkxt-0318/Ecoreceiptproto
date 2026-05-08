// Stage 8 — Score synthesis (CODE ONLY, NO LLM).
//
// Pure, deterministic. Same inputs → same outputs every time.
//
// Sub-score conventions:
//   - Each sub-score is in 0–25.
//   - `null` means "could not be computed due to insufficient input data."
//     This is distinct from 0 ("computed; the worst possible score").
//   - claim_integrity is null in the no-claims footprint-only path.
//   - material_sourcing / end_of_life are null when ALL of their underlying
//     Footprint inputs are null. If any input is present, the missing ones
//     contribute 0 to the partial sum and the score is computed.
//   - carbon_footprint is computable from `percentile` alone, which is always
//     present from the category baseline lookup → effectively never null.
//
// EcoScore: sum of non-null sub-scores, rescaled to 0–100. With all four
// present, max sum is 100 and ecoscore equals it. With one null (e.g.
// no-claims path), max sum is 75 → multiply by 100/75 to scale.

import type {
  Footprint,
  StatusBadge,
  SubScores,
  Verdict,
} from './types.js';

// ─── Sub-score 1: claim integrity ────────────────────────────────────────────

function computeClaimIntegrity(verdicts: Verdict[]): number | null {
  if (verdicts.length === 0) return null;
  let score = 25;
  for (const v of verdicts) {
    if (v.verdict_type === 'FAILED' || v.verdict_type === 'CONTRADICTED_BY_PRIMARY') {
      score -= 5;
    } else if (v.verdict_type === 'INSUFFICIENT_EVIDENCE') {
      score -= 2;
    }
  }
  return Math.max(0, score);
}

// ─── Sub-score 2: carbon footprint ───────────────────────────────────────────
// Linear: P10 → 25, P50 → 12.5, P90 → 0. Clamp [0, 25].

function computeCarbonFootprint(footprint: Footprint): number {
  const raw = 25 * (1 - footprint.percentile / 100);
  return Math.max(0, Math.min(25, raw));
}

// ─── Sub-score 3: material & sourcing ────────────────────────────────────────
// Components (max 25 total):
//   - recycled_content_pct (0–100) → 0–6 points (linear)
//   - water_stress inverted: (5 - baseline) / 5 → 0–6 points
//   - regulatory_regime_score (0–1) → 0–6 points
//   - certified_input_flag → 7 points if true, else 0
// Returns null only if EVERY component is null.

function computeMaterialSourcing(footprint: Footprint): number | null {
  const {
    recycled_content_pct,
    water_stress_baseline,
    regulatory_regime_score,
    certified_input_flag,
  } = footprint;
  const allNull =
    recycled_content_pct === null &&
    water_stress_baseline === null &&
    regulatory_regime_score === null &&
    certified_input_flag === null;
  if (allNull) return null;
  let score = 0;
  if (recycled_content_pct !== null) {
    score += 6 * (recycled_content_pct / 100);
  }
  if (water_stress_baseline !== null) {
    const inverted = Math.max(0, (5 - water_stress_baseline) / 5);
    score += 6 * inverted;
  }
  if (regulatory_regime_score !== null) {
    score += 6 * regulatory_regime_score;
  }
  if (certified_input_flag === true) {
    score += 7;
  }
  return Math.max(0, Math.min(25, score));
}

// ─── Sub-score 4: end of life ────────────────────────────────────────────────
// Three components (max 25 total):
//   - recyclability_score (0–1) → 0–9 points
//   - biodegradability_score (0–1) → 0–8 points
//   - repair_score (0–1) → 0–8 points
// Returns null only if EVERY component is null.

function computeEndOfLife(footprint: Footprint): number | null {
  const { recyclability_score, biodegradability_score, repair_score } = footprint;
  const allNull =
    recyclability_score === null &&
    biodegradability_score === null &&
    repair_score === null;
  if (allNull) return null;
  let score = 0;
  if (recyclability_score !== null) score += 9 * recyclability_score;
  if (biodegradability_score !== null) score += 8 * biodegradability_score;
  if (repair_score !== null) score += 8 * repair_score;
  return Math.max(0, Math.min(25, score));
}

// ─── Public: synthesize all four sub-scores ──────────────────────────────────

export function synthesizeScores(
  verdicts: Verdict[],
  footprint: Footprint,
): SubScores {
  return {
    claim_integrity: computeClaimIntegrity(verdicts),
    carbon_footprint: computeCarbonFootprint(footprint),
    material_sourcing: computeMaterialSourcing(footprint),
    end_of_life: computeEndOfLife(footprint),
  };
}

// ─── EcoScore ────────────────────────────────────────────────────────────────

/**
 * EcoScore = sum(non-null sub-scores) rescaled to 0–100. If any sub-score is
 * null, it is removed from both numerator (its value) and denominator (its 25-pt
 * cap) before scaling. Rounded to integer.
 */
export function computeEcoScore(subScores: SubScores): number {
  const values = [
    subScores.claim_integrity,
    subScores.carbon_footprint,
    subScores.material_sourcing,
    subScores.end_of_life,
  ];
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return 0;
  const sum = present.reduce((a, b) => a + b, 0);
  const cap = 25 * present.length;
  return Math.round((sum / cap) * 100);
}

// ─── Status badge mapping ────────────────────────────────────────────────────
// Order matters: we check the most damning conditions first so a contradicted
// verdict can't slip through to MIXED_SIGNALS just because the score happens
// to land in the middle band.

export function computeStatusBadge(
  verdicts: Verdict[],
  subScores: SubScores,
  ecoscore: number,
): StatusBadge {
  const hasContradicted = verdicts.some(
    (v) => v.verdict_type === 'CONTRADICTED_BY_PRIMARY',
  );
  if (hasContradicted) return 'GREENWASHING_DETECTED';

  const ci = subScores.claim_integrity;

  if (ci !== null && ci < 10) return 'GREENWASHING_DETECTED';
  if (ci !== null && ci >= 10 && ci <= 17 && ecoscore < 50) {
    return 'UNSUBSTANTIATED';
  }
  if (ci === null) return 'NO_CLAIMS_CONVENTIONAL';
  if (ecoscore >= 75 && ci >= 20) return 'VERIFIED_SUSTAINABLE';
  if (ecoscore >= 50 && ecoscore < 75) return 'MIXED_SIGNALS';

  return 'MIXED_SIGNALS';
}
