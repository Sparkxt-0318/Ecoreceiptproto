// Scope — climate disclosure auditor. Checks claims like "carbon neutral"
// or "net zero by 2030" against GHG Protocol Corporate Standard scope
// disclosure requirements (Scope 1/2/3 reporting completeness).

import type { LlmAnthropic } from '../llm.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'disclosure',
  standard_name: 'GHG Protocol Corporate Standard',
};

export function runScopeSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG, claim, evidence, client);
}
