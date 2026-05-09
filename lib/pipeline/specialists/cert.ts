// Cert — certification claim auditor. Checks claims like "FSC certified"
// or "B Corp" against the relevant public certifier registry.
//
// Two evidence-slice paths:
//   1. Manufacturer is in KNOWN_CERTIFICATIONS — synthesize a Tier-2
//      EvidenceItem listing the manufacturer's actual certifications
//      from the registry. The cert specialist can then return VERIFIED
//      or FAILED with a real registry URL (bcorporation.net, etc.).
//   2. Manufacturer not in our table — fall back to the original
//      registry-pointer path: a synthetic item with lookup_status
//      'not_fetched_in_mvp', and the specialist returns
//      INSUFFICIENT_EVIDENCE. Honest.
//
// In either case the output's rebuttal_source_tier is 2 (certifier
// database = standards body), which Stage 7 lets through. Honesty gate
// preserved.

import type { LlmAnthropic } from '../llm.js';
import {
  CERTIFIER_LOOKUPS,
  identifyCertifier,
  lookupCertifications,
  type Certification,
} from '../data/certifier_lookups.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'certification',
  standard_name: 'certifier database verification',
};

const CERT_RIDER = `

ADDITIONAL RULES FOR CERTIFICATION CLAIMS:

The evidence may include either:
  (a) A registry-derived item with data.registry_records — a list of the
      manufacturer's verified certifications. Use this to decide:
        - VERIFIED if the registry confirms the claimed certification.
        - FAILED if the registry has no record of the claimed certification.
      The rebuttal_source_url MUST be a registry_url from the records (or
      the data.registry_index_url when issuing FAILED for absence).
      The rebuttal_quote MUST quote the registry record verbatim, e.g.
      "B Lab registry confirms Patagonia, Inc. as certified B Corp", or
      describe absence: "B Lab registry returns no record for Kraft Heinz".
      rebuttal_source_tier = 2 (standards body).
  (b) A registry-pointer item with data.lookup_status === "not_fetched_in_mvp"
      and no registry_records. In this case output INSUFFICIENT_EVIDENCE
      with provision_cited="certifier database not verified" and
      rebuttal_source_url=the lookup_url. We have not fetched the registry
      for this manufacturer in this build — do not pretend to verify.`;

const CONFIG_WITH_RIDER = {
  ...CONFIG,
  standard_name: CONFIG.standard_name + CERT_RIDER,
};

function recordsToTextSummary(records: Certification[]): string {
  if (records.length === 0) {
    return '(no certifications on record for this manufacturer)';
  }
  return records
    .map(
      (r) =>
        `- ${r.cert_name} by ${r.certifier} (verified=${r.verified}, registry=${r.registry_url}, last_verified=${r.verified_date})`,
    )
    .join('\n');
}

/**
 * Build the cert-specific evidence slice. Two paths:
 *   - manufacturer known to KNOWN_CERTIFICATIONS → prepend a Tier-2
 *     EvidenceItem with the actual registry records.
 *   - manufacturer unknown → prepend the existing registry-pointer item
 *     with lookup_status='not_fetched_in_mvp' for the identified certifier
 *     (if any) so the specialist correctly issues IE.
 */
export function buildCertEvidenceSlice(
  claim: Claim,
  brandSiteEvidence: EvidenceItem[],
  manufacturer?: string,
): EvidenceItem[] {
  // Path 1: known manufacturer with registry data.
  if (manufacturer) {
    const records = lookupCertifications(manufacturer);
    if (records !== null) {
      const synthetic: EvidenceItem = {
        source: 'brand_site', // closest existing enum value; data.registry_records is the signal
        status: 'ok',
        url:
          records[0]?.registry_url ??
          'https://www.bcorporation.net/en-us/find-a-b-corp/',
        tier: 2,
        data: {
          manufacturer,
          registry_records: records,
          registry_index_url:
            records[0]?.registry_url ??
            'https://www.bcorporation.net/en-us/find-a-b-corp/',
          summary: recordsToTextSummary(records),
        },
        fetched_at: new Date().toISOString(),
        content_hash: 'c'.repeat(64),
      };
      return [synthetic, ...brandSiteEvidence];
    }
  }

  // Path 2: unknown manufacturer; fall back to registry-pointer behavior.
  const cert = identifyCertifier(claim.quote);
  if (!cert) return brandSiteEvidence;

  const lookup = CERTIFIER_LOOKUPS[cert];
  const synthetic: EvidenceItem = {
    source: 'brand_site',
    status: 'ok',
    url: lookup.lookup_url,
    tier: 2,
    data: {
      lookup_url: lookup.lookup_url,
      lookup_status: 'not_fetched_in_mvp',
      certifier: cert,
      description: lookup.description,
    },
    fetched_at: new Date().toISOString(),
    content_hash: 'b'.repeat(64),
  };

  return [synthetic, ...brandSiteEvidence];
}

export function runCertSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG_WITH_RIDER, claim, evidence, client);
}
