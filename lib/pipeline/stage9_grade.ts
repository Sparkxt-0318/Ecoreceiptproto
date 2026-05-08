// Stage 9 — Confidence grade (CODE ONLY, NO LLM).
//
// Grades the final receipt A/B/C based on (a) the tier distribution of the
// surviving verdicts and (b) how many evidence streams returned data.
//
// Rules from spec:
//   A: ≥80% of verdicts cite Tier 1–2 sources AND all evidence streams returned
//   B: any verdicts cite Tier 3, OR exactly 1 evidence stream missing
//   C: >30% of verdicts are INSUFFICIENT_EVIDENCE, OR ≥2 evidence streams missing
//
// In footprint-only mode (no verdicts), grade purely on evidence-stream coverage.
// We check C-conditions first so a degraded run can't accidentally grade A.

import type { ConfidenceGrade, RawEvidence, Verdict } from './types.js';

function countMissingStreams(evidence: RawEvidence): number {
  return evidence.items.filter((it) => it.status !== 'ok').length;
}

export function computeConfidenceGrade(
  verdicts: Verdict[],
  evidence: RawEvidence,
): ConfidenceGrade {
  const missing = countMissingStreams(evidence);

  // Footprint-only mode: grade on evidence coverage alone.
  if (verdicts.length === 0) {
    if (missing >= 2) return 'C';
    if (missing === 1) return 'B';
    return 'A';
  }

  const total = verdicts.length;
  const insufficientCount = verdicts.filter(
    (v) => v.verdict_type === 'INSUFFICIENT_EVIDENCE',
  ).length;
  const tier12Count = verdicts.filter((v) => v.rebuttal_source_tier <= 2).length;
  const hasTier3 = verdicts.some((v) => v.rebuttal_source_tier === 3);

  // Worst case first.
  if (insufficientCount / total > 0.3) return 'C';
  if (missing >= 2) return 'C';

  // Then check if A is achievable.
  if (tier12Count / total >= 0.8 && missing === 0 && !hasTier3) return 'A';

  // Otherwise B.
  return 'B';
}
