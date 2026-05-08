// Cert — certification claim auditor. Checks claims like "FSC certified"
// or "B Corp" against the relevant public certifier registry.
//
// MVP behavior: we do NOT actually fetch the registry in stage 5. Instead
// the cert specialist receives a synthetic evidence item containing
// {lookup_url, lookup_status: 'not_fetched_in_mvp'} and is instructed to
// treat that as INSUFFICIENT_EVIDENCE. Honest behavior — we aren't
// pretending to verify when we can't.

import type { LlmAnthropic } from '../llm.js';
import {
  CERTIFIER_LOOKUPS,
  identifyCertifier,
} from '../data/certifier_lookups.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'certification',
  standard_name: 'certifier database verification',
};

const CERT_RIDER = `

ADDITIONAL RULE FOR CERTIFICATION CLAIMS: If any evidence item has data.lookup_status === "not_fetched_in_mvp", you MUST output verdict=INSUFFICIENT_EVIDENCE with provision_cited="certifier database not verified" and rebuttal_source_url=the lookup_url. We have not fetched the registry in this build — do not pretend to verify.`;

const CONFIG_WITH_RIDER = {
  ...CONFIG,
  standard_name: CONFIG.standard_name + CERT_RIDER,
};

/**
 * Build the cert-specific evidence slice. Identifies the certifier in the
 * claim quote and prepends a synthetic registry-lookup item to whatever
 * brand_site evidence the orchestrator passed in.
 */
export function buildCertEvidenceSlice(
  claim: Claim,
  brandSiteEvidence: EvidenceItem[],
): EvidenceItem[] {
  const cert = identifyCertifier(claim.quote);
  if (!cert) return brandSiteEvidence;

  const lookup = CERTIFIER_LOOKUPS[cert];
  const synthetic: EvidenceItem = {
    source: 'brand_site', // closest existing source enum value; the data shape is the signal
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
