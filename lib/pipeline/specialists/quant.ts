// Quant — quantitative claim auditor. Checks numeric/percentage claims
// against FTC Green Guides §260.5 substantiation requirements.

import type { LlmAnthropic } from '../llm.js';
import type { Claim, EvidenceItem } from '../types.js';
import { runSpecialist, type SpecialistResult } from './base.js';

const CONFIG = {
  audit_type: 'quantitative',
  standard_name: 'FTC Green Guides §260.5 (substantiation requirement)',
};

export function runQuantSpecialist(
  claim: Claim,
  evidence: EvidenceItem[],
  client?: LlmAnthropic,
): Promise<SpecialistResult> {
  return runSpecialist(CONFIG, claim, evidence, client);
}
