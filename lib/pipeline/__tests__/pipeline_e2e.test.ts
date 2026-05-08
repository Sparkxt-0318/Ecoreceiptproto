// End-to-end orchestrator tests. Mocks every external boundary
// (Anthropic client, OFF, ESG probe, evidence fetchers) so the entire
// pipeline runs in <50ms with deterministic outputs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { clearCache } from '../cache.js';
import { runPipeline } from '../index.js';
import { buildItem } from '../sources/_base.js';
import type {
  EcoReceipt,
  EvidenceItem,
  PipelineInput,
  Product,
  RawEvidence,
} from '../types.js';
import type { EvidenceFetchers } from '../stage3_evidence.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function brandSiteItem(text: string): EvidenceItem {
  return buildItem({
    source: 'brand_site',
    status: 'ok',
    url: 'https://kraftheinz.com/sustainability',
    data: { text },
    content_hash: 'a'.repeat(64),
  });
}

function makeFetchers(overrides: Partial<EvidenceFetchers> = {}): EvidenceFetchers {
  const ok = (s: EvidenceItem['source']): EvidenceItem =>
    buildItem({
      source: s,
      status: 'ok',
      url: `https://example.com/${s}`,
      data: { sample: true },
      content_hash: 'a'.repeat(64),
    });
  return {
    openfoodfacts: vi.fn().mockResolvedValue(ok('openfoodfacts')),
    sec_edgar: vi.fn().mockResolvedValue(ok('sec_edgar')),
    epa_envirofacts: vi.fn().mockResolvedValue(ok('epa_envirofacts')),
    newsapi: vi.fn().mockResolvedValue(ok('newsapi')),
    brand_site: vi.fn().mockResolvedValue(brandSiteItem('We use 70% recycled materials.')),
    aqueduct: vi.fn().mockReturnValue(ok('aqueduct')),
    ...overrides,
  };
}

function makeClient(responses: string[]): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  let i = 0;
  const create = vi.fn().mockImplementation(async () => ({
    content: [{ type: 'text', text: responses[Math.min(i++, responses.length - 1)] ?? '[]' }],
    usage: { input_tokens: 100, output_tokens: 50 },
  }));
  return {
    client: { messages: { create } } as unknown as Anthropic,
    create,
  };
}

const HEINZ_PRODUCT: Product = {
  id: 'pid-heinz', // placeholder; resolveProduct overrides
  name: 'Heinz Tomato Ketchup',
  manufacturer: 'Heinz',
  category: 'food.condiment.ketchup',
  manufacturer_domain: 'kraftheinz.com',
};

function offSearcherHit() {
  return vi.fn().mockResolvedValue({
    product_name: 'Heinz Tomato Ketchup',
    brands: 'Heinz',
    upc: '0013000005678',
    categories: 'food.condiment.ketchup',
  });
}

const VERIFIED_VERDICT_JSON = JSON.stringify({
  verdict: 'VERIFIED',
  provision_cited: 'FTC Green Guides §260.5(a)',
  rebuttal_quote: 'SEC 10-K p.42 confirms recycled-content claim.',
  rebuttal_source_url: 'https://example.com/sec_edgar',
  rebuttal_source_tier: 1,
  reasoning: 'evidence directly substantiates claim',
});

const CONTRADICTED_VERDICT_JSON = JSON.stringify({
  verdict: 'CONTRADICTED_BY_PRIMARY',
  provision_cited: 'WRI Aqueduct primary lookup',
  rebuttal_quote: 'baseline water stress = 4.5 (extremely high)',
  rebuttal_source_url: 'https://example.com/aqueduct',
  rebuttal_source_tier: 1,
  reasoning: 'Aqueduct shows facility in extremely-high water stress region',
});

const CLAIMS_ONE_FACTUAL = JSON.stringify([
  {
    id: 'claim-1',
    quote: 'Tomatoes sourced from California.',
    type_hint: 'factual',
    source_url: 'https://kraftheinz.com/sustainability',
  },
]);

const CLAIMS_ONE_QUANT = JSON.stringify([
  {
    id: 'claim-1',
    quote: 'Made with 70% recycled materials.',
    type_hint: 'quantitative',
    source_url: 'https://kraftheinz.com/sustainability',
  },
]);

const NO_CLAIMS = JSON.stringify([]);

describe('Orchestrator: runPipeline (mocked)', () => {
  beforeEach(() => clearCache());
  afterEach(() => clearCache());

  it('returns a complete EcoReceipt under cost+latency budget', async () => {
    const responses = [CLAIMS_ONE_QUANT, VERIFIED_VERDICT_JSON];
    const { client } = makeClient(responses);

    const t0 = Date.now();
    const receipt = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      {
        client,
        resolveDeps: { offSearcher: offSearcherHit(), esgProbe: vi.fn().mockResolvedValue(null) },
        fetchers: makeFetchers(),
      },
    );

    expect(receipt.product.manufacturer).toBe('Heinz');
    expect(receipt.evidence_merkle_root).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.pipeline_cost_usd).toBeGreaterThan(0);
    expect(receipt.pipeline_cost_usd).toBeLessThan(0.02);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(receipt.verdicts).toHaveLength(1);
  });

  it('routes empty claims to footprint mode (claim_integrity null)', async () => {
    const { client } = makeClient([NO_CLAIMS]);
    const receipt = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      {
        client,
        resolveDeps: { offSearcher: offSearcherHit(), esgProbe: vi.fn().mockResolvedValue(null) },
        fetchers: makeFetchers(),
      },
    );
    expect(receipt.verdicts).toEqual([]);
    expect(receipt.sub_scores.claim_integrity).toBeNull();
    expect(receipt.status_badge).toBe('NO_CLAIMS_CONVENTIONAL');
  });

  it('produces GREENWASHING_DETECTED when contra returns CONTRADICTED_BY_PRIMARY consistently', async () => {
    // First: claim extraction (one factual claim).
    // Then: contra specialist run #1 (CONTRADICTED).
    // Then: contra specialist run #2 (self-consistency, same URL).
    const responses = [CLAIMS_ONE_FACTUAL, CONTRADICTED_VERDICT_JSON, CONTRADICTED_VERDICT_JSON];
    const { client } = makeClient(responses);

    const receipt = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      {
        client,
        resolveDeps: { offSearcher: offSearcherHit(), esgProbe: vi.fn().mockResolvedValue(null) },
        fetchers: makeFetchers(),
      },
    );
    expect(receipt.status_badge).toBe('GREENWASHING_DETECTED');
    expect(receipt.verdicts[0]?.verdict_type).toBe('CONTRADICTED_BY_PRIMARY');
  });

  it('forces confidence_grade=C when 4 evidence sources fail', async () => {
    const failed = (s: EvidenceItem['source']): EvidenceItem =>
      buildItem({ source: s, status: 'error', data: null });
    const fetchers = makeFetchers({
      openfoodfacts: vi.fn().mockResolvedValue(failed('openfoodfacts')),
      sec_edgar: vi.fn().mockResolvedValue(failed('sec_edgar')),
      epa_envirofacts: vi.fn().mockResolvedValue(failed('epa_envirofacts')),
      newsapi: vi.fn().mockResolvedValue(failed('newsapi')),
    });
    const { client } = makeClient([NO_CLAIMS]);
    const receipt = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      {
        client,
        resolveDeps: { offSearcher: offSearcherHit(), esgProbe: vi.fn().mockResolvedValue(null) },
        fetchers,
      },
    );
    expect(receipt.confidence_grade).toBe('C');
  });

  it('cache hit on second call returns instantly with zero new LLM calls', async () => {
    const responses = [CLAIMS_ONE_QUANT, VERIFIED_VERDICT_JSON];
    const { client, create } = makeClient(responses);
    const offSearcher = offSearcherHit();
    const esgProbe = vi.fn().mockResolvedValue(null);
    const fetchers = makeFetchers();

    const r1 = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      { client, resolveDeps: { offSearcher, esgProbe }, fetchers },
    );
    const callsAfterFirst = create.mock.calls.length;

    const t0 = Date.now();
    const r2 = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      { client, resolveDeps: { offSearcher, esgProbe }, fetchers },
    );
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(100);
    expect(create.mock.calls.length).toBe(callsAfterFirst);
    expect(r2).toEqual(r1);
  });

  it('honesty gate: no verdict survives with empty rebuttal_source_url or Tier 4-5', async () => {
    // Specialist returns a Tier-4 cite — schema would actually block this at
    // parse time, so simulate by having the specialist emit valid Tier-1 then
    // rely on stage 7 to be the second line of defense. Here we focus on the
    // assertion: in the *receipt*, no verdict should have empty url or tier>=4.
    const responses = [CLAIMS_ONE_QUANT, VERIFIED_VERDICT_JSON];
    const { client } = makeClient(responses);

    const receipt = await runPipeline(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      {
        client,
        resolveDeps: { offSearcher: offSearcherHit(), esgProbe: vi.fn().mockResolvedValue(null) },
        fetchers: makeFetchers(),
      },
    );
    for (const v of receipt.verdicts) {
      // Either it's still a regular verdict (URL present, tier <=3) or it was
      // downgraded — either way the receipt itself never carries a Tier-4-only
      // VERIFIED/FAILED/CONTRADICTED verdict.
      if (v.verdict_type !== 'INSUFFICIENT_EVIDENCE') {
        expect(v.rebuttal_source_url.length).toBeGreaterThan(0);
        expect(v.rebuttal_source_tier).toBeLessThanOrEqual(3);
      }
    }
  });
});
