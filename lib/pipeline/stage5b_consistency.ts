// Stage 5b — Self-consistency check on CONTRADICTED_BY_PRIMARY verdicts.
//
// The Contra specialist is the only path that can produce a
// GREENWASHING_DETECTED status_badge by itself. False positives there are
// reputationally expensive — accusing a brand of greenwashing when they
// haven't is worse than missing a real instance. So we re-run the specialist
// once and demand the same rebuttal_source_url both times.
//
// If the URLs differ, the contradiction is unstable → downgrade to
// INSUFFICIENT_EVIDENCE. The verdict body is preserved; only verdict_type and
// downgrade_reason change.
//
// This stage runs only on CONTRADICTED_BY_PRIMARY verdicts. Any other
// verdict_type passes through untouched.

import type { SpecialistOutput, Verdict } from './types.js';

export const SELF_CONSISTENCY_REASON =
  'self-consistency check failed: rebuttal source url differed across runs';

export type SpecialistRunner = () => Promise<SpecialistOutput>;

/**
 * Re-run the supplied specialist function once and compare its rebuttal URL to
 * the original verdict. Same URL → keep the verdict. Different URL → downgrade.
 *
 * The specialist is injected so callers can mock it in tests and so the real
 * orchestrator can pass a closure capturing the claim + evidence.
 */
export async function runSelfConsistencyCheck(
  verdict: Verdict,
  specialist: SpecialistRunner,
): Promise<Verdict> {
  if (verdict.verdict_type !== 'CONTRADICTED_BY_PRIMARY') return verdict;

  const second = await specialist();

  if (second.rebuttal_source_url === verdict.rebuttal_source_url) {
    return verdict;
  }

  return {
    ...verdict,
    verdict_type: 'INSUFFICIENT_EVIDENCE',
    downgrade_reason: SELF_CONSISTENCY_REASON,
  };
}
