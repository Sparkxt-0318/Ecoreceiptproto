// End-to-end smoke test: run the real pipeline against the 4 reference
// products and print the resulting EcoReceipts plus an aggregate summary.
//
// Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/smoke.ts
//        ANTHROPIC_API_KEY=sk-... NEWSAPI_KEY=... npx tsx scripts/smoke.ts
//
// Without ANTHROPIC_API_KEY set, the script prints a guard message and exits
// 0 — useful for environments where the smoke test should be opt-in.
//
// Honest cost reporting: the script prints per-product duration_ms and
// pipeline_cost_usd from each receipt and a final aggregate.

import { clearCache, runPipeline } from '../lib/pipeline/index.js';
import type { EcoReceipt, PipelineInput } from '../lib/pipeline/types.js';

const PRODUCTS: Array<{ label: string; input: PipelineInput }> = [
  { label: 'Heinz Tomato Ketchup 14oz', input: { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' } },
  {
    label: 'Patagonia Better Sweater Fleece Jacket',
    input: { kind: 'text', value: 'Patagonia Better Sweater Fleece Jacket' },
  },
  {
    label: 'Great Value canned tomatoes 14.5oz',
    input: { kind: 'text', value: 'great value canned tomatoes 14.5oz' },
  },
  {
    label: 'Delta Airlines carbon-neutral flight',
    input: { kind: 'text', value: 'Delta Airlines carbon neutral flight' },
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      '[smoke] ANTHROPIC_API_KEY not set; this script makes real API calls and would cost money.\n' +
        '       Set ANTHROPIC_API_KEY and re-run, or run `npm test` for the mocked unit suite.',
    );
    process.exit(0);
  }

  clearCache();

  const t0 = Date.now();
  let totalCost = 0;
  const results: Array<{ label: string; receipt: EcoReceipt | null; error?: string }> = [];

  for (const { label, input } of PRODUCTS) {
    console.log(`\n=== ${label} ===`);
    const t = Date.now();
    try {
      const receipt = await runPipeline(input);
      totalCost += receipt.pipeline_cost_usd;
      console.log(JSON.stringify(receipt, null, 2));
      console.log(
        `[summary] ${label} → badge=${receipt.status_badge} grade=${receipt.confidence_grade} ecoscore=${receipt.ecoscore} cost=$${receipt.pipeline_cost_usd.toFixed(4)} duration=${Date.now() - t}ms`,
      );
      results.push({ label, receipt });
    } catch (e) {
      const message = (e as Error).message;
      console.log(`[error] ${label}: ${message}`);
      results.push({ label, receipt: null, error: message });
    }
  }

  console.log('\n========== SUMMARY ==========');
  console.log(`Total wall-clock: ${Date.now() - t0} ms`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Average cost/product: $${(totalCost / PRODUCTS.length).toFixed(4)}`);
  for (const { label, receipt, error } of results) {
    if (receipt) {
      console.log(
        `  ${label}: ${receipt.status_badge} (grade ${receipt.confidence_grade}, score ${receipt.ecoscore})`,
      );
    } else {
      console.log(`  ${label}: ERROR — ${error}`);
    }
  }

  // Honesty-gate audit: scan every verdict in every receipt.
  let violations = 0;
  for (const { label, receipt } of results) {
    if (!receipt) continue;
    for (const v of receipt.verdicts) {
      if (v.verdict_type === 'INSUFFICIENT_EVIDENCE') continue;
      if (v.rebuttal_source_tier >= 4) {
        console.log(`[honesty] FAIL: ${label} verdict ${v.claim_id} cites Tier ${v.rebuttal_source_tier}`);
        violations++;
      }
      if (!v.rebuttal_source_url || v.rebuttal_source_url.length === 0) {
        console.log(`[honesty] FAIL: ${label} verdict ${v.claim_id} has empty rebuttal_source_url`);
        violations++;
      }
    }
  }
  if (violations === 0) {
    console.log('[honesty] OK — no surviving Tier-4-only or empty-URL verdicts');
  } else {
    console.log(`[honesty] ${violations} violation(s) — pipeline must be fixed before release`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[smoke] fatal', e);
  process.exit(2);
});
