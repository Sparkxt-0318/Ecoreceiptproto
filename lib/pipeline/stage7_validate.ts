// Stage 7 — Tier validator (CODE ONLY, NO LLM).
//
// The honesty gate. Every NON-INSUFFICIENT_EVIDENCE verdict must clear FOUR
// checks before it is allowed into the final receipt:
//
//   1. rebuttal_source_url does NOT cite the LLM-summary fallback. Brand-site
//      content synthesized from training knowledge is acceptable as Stage 4
//      input but never as primary evidence — citing it would let model
//      hallucination pose as a verified fact.
//   2. rebuttal_source_tier ∈ {1, 2, 3} — Tier 4 (brand-controlled) and
//      Tier 5 (social/marketing) are not acceptable evidence for a verdict.
//   3. rebuttal_source_url is non-empty AND (when evidence is provided) appears
//      in the original evidence array. Specialists cannot invent URLs.
//   4. provision_cited is non-empty. Cite-or-die: every verdict must name the
//      standard or provision it relies on.
//
// Failure of any check downgrades the verdict to INSUFFICIENT_EVIDENCE and
// records a human-readable reason in `downgrade_reason`. The LLM-fallback
// check runs FIRST so that "fallback URL" wins as the explanation when a
// verdict happens to fail multiple checks at once.
//
// SHORT-CIRCUIT for self-classified IE verdicts: when the specialist itself
// returned `verdict_type: 'INSUFFICIENT_EVIDENCE'`, source-tier rules don't
// apply (the model is honestly admitting it has no source). The verdict is
// passed through with its real `provision_cited` and `reasoning` preserved,
// only the EMPTY_PROVISION check still runs. This is what differentiates
// "I checked FTC §260.5(a) but found nothing usable" (kept) from "output
// validation failed" (synthetic boilerplate).
//
// Honesty-gate property preserved: no SourcedVerdict (VERIFIED / FAILED /
// CONTRADICTED_BY_PRIMARY) ever survives with Tier-4/5, empty URL, fallback
// URL, or empty provision. That guarantee is what the receipt depends on.

import { LLM_FALLBACK_TOKEN } from './sources/web_fetch.js';
import type { RawEvidence, Verdict } from './types.js';

const REASONS = {
  SELF_REPORTED_IE: 'specialist self-reported insufficient evidence',
  LLM_FALLBACK: 'rebuttal cites llm-summary fallback',
  TIER: 'rebuttal source tier insufficient',
  EMPTY_URL: 'empty rebuttal source url',
  URL_NOT_IN_EVIDENCE: 'rebuttal source url not present in evidence',
  EMPTY_PROVISION: 'missing provision citation',
} as const;

function downgrade(verdict: Verdict, reason: string): Verdict {
  return {
    ...verdict,
    verdict_type: 'INSUFFICIENT_EVIDENCE',
    downgrade_reason: reason,
  };
}

/**
 * Validate a single verdict against the honesty rules.
 * If `evidence` is supplied, also enforces the URL-in-evidence membership check.
 */
export function validateVerdict(
  verdict: Verdict,
  evidence?: RawEvidence,
): Verdict {
  // Self-classified IE: specialist already opted out of making a substantive
  // claim. Source-tier / URL rules don't apply — preserve the real
  // provision_cited and reasoning so the receipt can show *what* the
  // specialist tried to check, not a "output validation failed" placeholder.
  // Cite-or-die still applies: empty provision still downgrades.
  if (verdict.verdict_type === 'INSUFFICIENT_EVIDENCE') {
    if (verdict.provision_cited.trim().length === 0) {
      return downgrade(verdict, REASONS.EMPTY_PROVISION);
    }
    return {
      ...verdict,
      downgrade_reason: verdict.downgrade_reason ?? REASONS.SELF_REPORTED_IE,
    };
  }

  // Run the LLM-fallback gate FIRST. Synthetic brand-site content (and the
  // cert specialist's "not_fetched_in_mvp" lookup placeholder, which uses the
  // same sentinel pattern) must never be promoted to primary evidence.
  if (verdict.rebuttal_source_url.includes(LLM_FALLBACK_TOKEN)) {
    return downgrade(verdict, REASONS.LLM_FALLBACK);
  }
  if (verdict.rebuttal_source_tier >= 4) {
    return downgrade(verdict, REASONS.TIER);
  }
  if (verdict.rebuttal_source_url.trim().length === 0) {
    return downgrade(verdict, REASONS.EMPTY_URL);
  }
  if (verdict.provision_cited.trim().length === 0) {
    return downgrade(verdict, REASONS.EMPTY_PROVISION);
  }
  if (evidence !== undefined) {
    const urls = new Set(
      evidence.items.map((it) => it.url).filter((u): u is string => Boolean(u)),
    );
    if (!urls.has(verdict.rebuttal_source_url)) {
      return downgrade(verdict, REASONS.URL_NOT_IN_EVIDENCE);
    }
  }
  return verdict;
}

/** Apply validateVerdict to every verdict in a batch. */
export function validateTiers(
  verdicts: Verdict[],
  evidence?: RawEvidence,
): Verdict[] {
  return verdicts.map((v) => validateVerdict(v, evidence));
}

export const VALIDATION_REASONS = REASONS;
