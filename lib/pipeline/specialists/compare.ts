// Compare — comparative claim auditor. Checks claims like "30% less plastic
// than before" against FTC Green Guides §260.6 (comparative claims must
// disclose the basis of comparison).

import type { LlmAnthropic } from '../llm.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'comparison',
  standard_name: 'FTC Green Guides §260.6 (comparative claims requirement)',
};

export function runCompareSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG, claim, evidence, client);
}
