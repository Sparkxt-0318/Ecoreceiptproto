// Contra — primary-source contradiction auditor. The highest-stakes
// specialist: only this one can produce CONTRADICTED_BY_PRIMARY, which
// drives the GREENWASHING_DETECTED status badge.
//
// Stage 5b's self-consistency check exists specifically to guard this
// path — false positives here are reputationally expensive.

import type { LlmAnthropic } from '../llm.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'factual',
  standard_name: 'primary source verification',
};

export function runContraSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG, claim, evidence, client);
}
