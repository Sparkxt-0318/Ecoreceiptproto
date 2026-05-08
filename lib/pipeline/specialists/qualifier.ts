// Qualifier — fuzzy term auditor. Checks claims like "eco-friendly" or
// "natural" against FTC Green Guides §260.4(b) (qualified claims).

import type { LlmAnthropic } from '../llm.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'qualitative',
  standard_name: 'FTC Green Guides §260.4(b) (qualified claims requirement)',
};

export function runQualifierSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG, claim, evidence, client);
}
