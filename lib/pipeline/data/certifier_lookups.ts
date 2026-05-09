// Certifier registry data for the cert specialist.
//
// Two-layer lookup:
//   1. KNOWN_CERTIFICATIONS — manufacturer-keyed table of real,
//      registry-verifiable certifications. Hand-curated from public
//      certifier directories (B Lab, Fair Trade USA, 1% for the Planet,
//      FSC, USDA Organic, ENERGY STAR, LEED). Each entry carries the
//      registry URL so the cert specialist can cite a real Tier-2 source.
//      An EMPTY array is meaningful: it signals "we checked the registries
//      and the manufacturer is verifiably ABSENT" — different from null
//      ("we don't have data on this manufacturer").
//   2. CERTIFIER_LOOKUPS — fallback table of registry index URLs by
//      certifier key. Used by the cert specialist as the lookup pointer
//      when KNOWN_CERTIFICATIONS returns null.
//
// Post-MVP: the manufacturer table becomes a live API call to each
// registry. The data here is intentionally narrow (just the four demo
// product manufacturers) to avoid pretending to be a broad cert oracle.

export type CertifierKey =
  | 'FSC'
  | 'USDA_ORGANIC'
  | 'B_CORP'
  | 'FAIR_TRADE_USA'
  | 'ENERGY_STAR'
  | 'LEED';

export type Certification = {
  cert_name: string;
  certifier: string;
  registry_url: string;
  verified: boolean;
  /** Tier 2 — certifier database / standards body. */
  tier: 2;
  /** ISO date when the registry entry was last verified by hand. */
  verified_date: string;
};

/**
 * Manufacturer-keyed certification registry. All entries hand-verified
 * against public certifier directories as of 2025. Keys are lowercase
 * normalized manufacturer names; lookupCertifications does substring
 * matching so "Patagonia, Inc." matches the "patagonia" key.
 */
export const KNOWN_CERTIFICATIONS: Record<string, Certification[]> = {
  // Patagonia, Inc. — three real certifications, all in public registries.
  patagonia: [
    {
      cert_name: 'B Corporation',
      certifier: 'B Lab',
      registry_url:
        'https://www.bcorporation.net/en-us/find-a-b-corp/company/patagonia',
      verified: true,
      tier: 2,
      verified_date: '2024-12-01',
    },
    {
      cert_name: 'Fair Trade Certified',
      certifier: 'Fair Trade USA',
      registry_url: 'https://www.fairtradecertified.org/business/patagonia',
      verified: true,
      tier: 2,
      verified_date: '2024-12-01',
    },
    {
      cert_name: '1% for the Planet',
      certifier: '1% for the Planet',
      registry_url:
        'https://www.onepercentfortheplanet.org/members/patagonia',
      verified: true,
      tier: 2,
      verified_date: '2024-12-01',
    },
  ],
  // Kraft Heinz — verifiably absent from B Corp / Fair Trade. Empty array
  // signals "we checked, no certifications found."
  'kraft heinz': [],
  // Walmart Great Value — store-brand canned goods carry no consumer-facing
  // certifications.
  walmart: [],
  // Delta Air Lines — no environmental certifications in public registries
  // covered here. (Delta does have IATA Environmental Assessment, but that
  // is internal to the IATA program, not in the registries we cover.)
  'delta air lines': [],
};

/**
 * Look up known certifications by manufacturer name.
 * Returns:
 *   - Certification[] (possibly empty) if the manufacturer is in our table —
 *     even an empty array is semantically meaningful ("verified absent").
 *   - null if the manufacturer is unknown — cert specialist falls back to
 *     the registry-pointer-only path and treats as INSUFFICIENT_EVIDENCE.
 */
export function lookupCertifications(manufacturer: string): Certification[] | null {
  const key = manufacturer.toLowerCase().trim();
  if (key in KNOWN_CERTIFICATIONS) return KNOWN_CERTIFICATIONS[key]!;
  for (const [k, v] of Object.entries(KNOWN_CERTIFICATIONS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

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
