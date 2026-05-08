// Hardcoded lookup URLs for the top consumer-facing eco-certifications.
// MVP behavior: we do NOT fetch these in stage 5 — the cert specialist receives
// {lookup_url, lookup_status: 'not_fetched_in_mvp'} and is instructed to return
// INSUFFICIENT_EVIDENCE. Honest, not pretending to verify.
//
// Post-MVP: real implementations would scrape the public registries here. The
// FSC and FairTrade lookups in particular are public and unauthenticated.

export type CertifierKey =
  | 'FSC'
  | 'USDA_ORGANIC'
  | 'B_CORP'
  | 'FAIR_TRADE_USA'
  | 'ENERGY_STAR'
  | 'LEED';

export const CERTIFIER_LOOKUPS: Record<CertifierKey, { lookup_url: string; description: string }> = {
  FSC: {
    lookup_url: 'https://info.fsc.org/certificate.php',
    description: 'Forest Stewardship Council certificate database',
  },
  USDA_ORGANIC: {
    lookup_url: 'https://organic.ams.usda.gov/integrity/',
    description: 'USDA Organic Integrity Database',
  },
  B_CORP: {
    lookup_url: 'https://www.bcorporation.net/en-us/find-a-b-corp/',
    description: 'B Lab Certified B Corporation directory',
  },
  FAIR_TRADE_USA: {
    lookup_url: 'https://www.fairtradecertified.org/products',
    description: 'Fair Trade USA certified product registry',
  },
  ENERGY_STAR: {
    lookup_url: 'https://www.energystar.gov/productfinder/',
    description: 'EPA ENERGY STAR product finder',
  },
  LEED: {
    lookup_url: 'https://www.usgbc.org/projects',
    description: 'USGBC LEED-certified project directory',
  },
};

const KEYWORDS: Array<[RegExp, CertifierKey]> = [
  [/\b(fsc|forest stewardship)\b/i, 'FSC'],
  [/\busda organic|certified organic\b/i, 'USDA_ORGANIC'],
  [/\bb[\s-]?corp(oration)?\b/i, 'B_CORP'],
  [/\bfair[\s-]?trade\b/i, 'FAIR_TRADE_USA'],
  [/\benergy\s*star\b/i, 'ENERGY_STAR'],
  [/\bleed\b/i, 'LEED'],
];

/**
 * Identify which (if any) certifier a claim quote refers to. Returns null if
 * no match — cert specialist will treat that as INSUFFICIENT_EVIDENCE.
 */
export function identifyCertifier(claimQuote: string): CertifierKey | null {
  for (const [re, key] of KEYWORDS) {
    if (re.test(claimQuote)) return key;
  }
  return null;
}
