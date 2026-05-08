// Static tier classification of every evidence source the pipeline ingests.
//
// Tier is the source's intrinsic credibility — independent of the specific
// fetched page. Specialists' rebuttal_source_tier should equal SOURCE_TIERS
// for the source whose URL they cite. Stage 7 trusts SOURCE_TIERS, never
// the LLM's self-reported tier.
//
// Why these tiers (changing one is a substantive policy decision, not a typo
// fix — flag in PR if revising):
//   sec_edgar:        1 — sworn regulatory filings, fraud carries criminal liability.
//   epa_envirofacts:  1 — federal regulatory disclosures (TRI, FRS), audited.
//   aqueduct:         3 — peer-reviewed scientific dataset (WRI), but interpretive layer
//                         between raw data and our use, so not Tier 1.
//   openfoodfacts:    4 — crowd-sourced from product packaging; brands also edit.
//   brand_site:       4 — brand-controlled marketing; Tier 7's ban applies here.
//   newsapi:          5 — journalism varies wildly by outlet; usable as a *lead*
//                         to find a Tier 1–3 primary, never as a final rebuttal.

import type { EvidenceSource, SourceTier } from '../types.js';

export const SOURCE_TIERS: Record<EvidenceSource, SourceTier> = {
  openfoodfacts: 4,
  sec_edgar: 1,
  epa_envirofacts: 1,
  aqueduct: 3,
  newsapi: 5,
  brand_site: 4,
};
