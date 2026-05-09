// Phase-2 diagnostic: run Heinz + Patagonia with PIPELINE_DEBUG=1 so that
// stage3 (web_fetch) and stage4 (extract) emit their full trace to stderr.
// Stdout is still the receipt JSON so the two streams can be tee'd separately
// (e.g. `PIPELINE_DEBUG=1 npx tsx scripts/diagnose.ts 2>&1 | tee log`).

import { clearCache, runPipeline } from '../lib/pipeline/index.js';
import type { PipelineInput } from '../lib/pipeline/types.js';

const PRODUCTS: Array<{ label: string; input: PipelineInput }> = [
  { label: 'Heinz Tomato Ketchup 14oz', input: { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' } },
  {
    label: 'Patagonia Better Sweater Fleece Jacket',
    input: { kind: 'text', value: 'Patagonia Better Sweater Fleece Jacket' },
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[diagnose] ANTHROPIC_API_KEY not set; aborting');
    process.exit(0);
  }
  clearCache();

  for (const { label, input } of PRODUCTS) {
    console.error(`\n========== ${label} ==========`);
    try {
      const receipt = await runPipeline(input);
      console.error(
        `[result] ${label} → badge=${receipt.status_badge} verdicts=${receipt.verdicts.length} grade=${receipt.confidence_grade}`,
      );
    } catch (e) {
      console.error(`[error] ${label}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('[diagnose] fatal', e);
  process.exit(2);
});
