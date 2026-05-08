// Stage 6 (footprint mode) tests.

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { runFootprint } from '../stage6_footprint.js';
import type { EvidenceItem, Product, RawEvidence } from '../types.js';

function fakeProduct(category = 'food.condiment.ketchup'): Product {
  return {
    id: 'pid',
    name: 'Heinz Tomato Ketchup 14oz',
    manufacturer: 'Kraft Heinz',
    category,
  };
}

function emptyEvidence(): RawEvidence {
  return { items: [], degraded: false };
}

function evidenceWithOff(offData: unknown): RawEvidence {
  const item: EvidenceItem = {
    source: 'openfoodfacts',
    status: 'ok',
    url: 'https://world.openfoodfacts.org/x',
    tier: 4,
    data: offData,
    fetched_at: '2026-05-08T00:00:00.000Z',
    content_hash: 'a'.repeat(64),
  };
  return { items: [item], degraded: false };
}

function evidenceWithAqueduct(score: number): RawEvidence {
  const item: EvidenceItem = {
    source: 'aqueduct',
    status: 'ok',
    url: 'https://aqueduct.wri.org/x',
    tier: 3,
    data: { score },
    fetched_at: '2026-05-08T00:00:00.000Z',
    content_hash: 'a'.repeat(64),
  };
  return { items: [item], degraded: false };
}

function fakeClient(message?: { content: string; input?: number; output?: number }) {
  const create = vi.fn();
  if (message) {
    const msg = {
      content: [{ type: 'text', text: message.content }],
      usage: {
        input_tokens: message.input ?? 50,
        output_tokens: message.output ?? 20,
      },
    };
    create.mockResolvedValue(msg);
  }
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('Stage 6: runFootprint', () => {
  it('skips the LLM mapping call when category is already a known key', async () => {
    const { client, create } = fakeClient();
    const result = await runFootprint(fakeProduct(), emptyEvidence(), client);
    expect(create).not.toHaveBeenCalled();
    expect(result.footprint.category).toBe('food.condiment.ketchup');
    expect(result.footprint.co2e_kg).toBeGreaterThan(0);
    expect(result.cost_usd).toBe(0);
  });

  it('calls the LLM mapper when category is not in the baseline table', async () => {
    const { client, create } = fakeClient({
      content: JSON.stringify({ category: 'food.dairy.milk', confidence: 0.9 }),
    });
    const result = await runFootprint(
      { ...fakeProduct(), category: 'food.unknown' },
      emptyEvidence(),
      client,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.footprint.category).toBe('food.dairy.milk');
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('returns null metric inputs when LLM mapper returns null/low-confidence', async () => {
    const { client } = fakeClient({
      content: JSON.stringify({ category: null, confidence: 0 }),
    });
    const result = await runFootprint(
      { ...fakeProduct(), category: 'unknown.unknown' },
      emptyEvidence(),
      client,
    );
    expect(result.footprint.category).toBe('unknown');
    // material/EOL stay null when no OFF data and no category baseline
    expect(result.footprint.recycled_content_pct).toBeNull();
    expect(result.footprint.recyclability_score).toBeNull();
  });

  it('reads recyclability_score from OpenFoodFacts ecoscore data when present', async () => {
    const { client } = fakeClient();
    const result = await runFootprint(
      fakeProduct(),
      evidenceWithOff({ product: { ecoscore_data: { score: 80 } } }),
      client,
    );
    // 80/100 = 0.8
    expect(result.footprint.recyclability_score).toBeCloseTo(0.8, 5);
  });

  it('leaves OFF-derived fields null (not zero) when OFF data is missing', async () => {
    const { client } = fakeClient();
    const result = await runFootprint(fakeProduct(), emptyEvidence(), client);
    expect(result.footprint.recycled_content_pct).toBeNull();
    expect(result.footprint.recyclability_score).toBeNull();
    expect(result.footprint.biodegradability_score).toBeNull();
  });

  it('reads water_stress_baseline from aqueduct evidence when present', async () => {
    const { client } = fakeClient();
    const result = await runFootprint(
      fakeProduct(),
      evidenceWithAqueduct(4.5),
      client,
    );
    expect(result.footprint.water_stress_baseline).toBe(4.5);
  });
});
