// Phase-7 diagnostic: run Heinz only with PIPELINE_DEBUG=1. Heinz exercises
// every specialist (9 claims extracted, 6 schema-rejected, 3 fallback-cited
// in smoke run #3) so it's the cheapest single product to surface the
// specialist failure mode.
//
// Usage:
//   PIPELINE_DEBUG=1 ANTHROPIC_API_KEY=... npx tsx scripts/diagnose_heinz.ts \
//     2>&1 | tee /tmp/diagnose_heinz.log

import { clearCache, runPipeline } from '../lib/pipeline/index.js';

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[diagnose_heinz] ANTHROPIC_API_KEY not set; aborting');
    process.exit(0);
  }
  clearCache();

  console.error('========== Heinz Tomato Ketchup 14oz ==========');
  try {
    const receipt = await runPipeline({ kind: 'text', value: 'Heinz Tomato Ketchup 14oz' });
    console.error(
      `[result] badge=${receipt.status_badge} ecoscore=${receipt.ecoscore} grade=${receipt.confidence_grade} verdicts=${receipt.verdicts.length} cost=$${receipt.pipeline_cost_usd.toFixed(4)} duration=${receipt.pipeline_duration_ms}ms`,
    );
  } catch (e) {
    console.error(`[error] ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error('[diagnose_heinz] fatal', e);
  process.exit(2);
});
