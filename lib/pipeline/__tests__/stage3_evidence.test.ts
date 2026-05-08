// Stage 3 (evidence gather) tests. The `fetchers` arg is fully injected,
// so we mock at the source-fetcher boundary and never touch real fetch.

import { describe, expect, it, vi } from 'vitest';

import { gatherEvidence, type EvidenceFetchers } from '../stage3_evidence.js';
import { buildItem } from '../sources/_base.js';
import { EvidenceItemSchema } from '../schemas.js';
import type { EvidenceItem, Product } from '../types.js';

function fakeProduct(): Product {
  return {
    id: 'pid',
    name: 'Heinz Tomato Ketchup',
    manufacturer: 'Kraft Heinz',
    category: 'food.condiment.ketchup',
    manufacturer_domain: 'kraftheinz.com',
  };
}

function okItem(source: EvidenceItem['source']): EvidenceItem {
  return buildItem({
    source,
    status: 'ok',
    url: `https://example.com/${source}`,
    data: { hello: 'world' },
    content_hash: 'a'.repeat(64),
  });
}

function makeFetchers(overrides: Partial<EvidenceFetchers> = {}): EvidenceFetchers {
  return {
    openfoodfacts: vi.fn().mockResolvedValue(okItem('openfoodfacts')),
    sec_edgar: vi.fn().mockResolvedValue(okItem('sec_edgar')),
    epa_envirofacts: vi.fn().mockResolvedValue(okItem('epa_envirofacts')),
    newsapi: vi.fn().mockResolvedValue(okItem('newsapi')),
    brand_site: vi.fn().mockResolvedValue(okItem('brand_site')),
    aqueduct: vi.fn().mockReturnValue(okItem('aqueduct')),
    ...overrides,
  };
}

describe('Stage 3: gatherEvidence', () => {
  it('returns 6 ok items and degraded=false when all sources succeed', async () => {
    const result = await gatherEvidence(fakeProduct(), makeFetchers());
    expect(result.items).toHaveLength(6);
    expect(result.items.every((it) => it.status === 'ok')).toBe(true);
    expect(result.degraded).toBe(false);
    // Tier stamping
    const sec = result.items.find((it) => it.source === 'sec_edgar')!;
    expect(sec.tier).toBe(1);
    const brand = result.items.find((it) => it.source === 'brand_site')!;
    expect(brand.tier).toBe(4);
  });

  it('marks degraded=true when 3+ sources fail', async () => {
    const fetchers = makeFetchers({
      openfoodfacts: vi.fn().mockResolvedValue(
        buildItem({ source: 'openfoodfacts', status: 'error', data: null }),
      ),
      sec_edgar: vi.fn().mockResolvedValue(
        buildItem({ source: 'sec_edgar', status: 'timeout', data: null }),
      ),
      newsapi: vi.fn().mockResolvedValue(
        buildItem({ source: 'newsapi', status: 'error', data: null }),
      ),
    });
    const result = await gatherEvidence(fakeProduct(), fetchers);
    expect(result.degraded).toBe(true);
  });

  it('does not crash when a fetcher rejects (turns into error item)', async () => {
    const fetchers = makeFetchers({
      sec_edgar: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await gatherEvidence(fakeProduct(), fetchers);
    const sec = result.items.find((it) => it.source === 'sec_edgar')!;
    expect(sec.status).toBe('error');
    expect(result.items).toHaveLength(6);
  });

  it('every returned item passes EvidenceItemSchema validation', async () => {
    const result = await gatherEvidence(fakeProduct(), makeFetchers());
    for (const item of result.items) {
      expect(EvidenceItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it('content_hash is populated for ok items in valid sha256 hex format', async () => {
    const result = await gatherEvidence(fakeProduct(), makeFetchers());
    for (const item of result.items) {
      expect(item.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('Aqueduct receives EPA result and runs after it', async () => {
    let epaResolved = false;
    const epaItem = okItem('epa_envirofacts');
    const fetchers = makeFetchers({
      epa_envirofacts: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        epaResolved = true;
        return epaItem;
      }),
      aqueduct: vi.fn().mockImplementation((epa) => {
        expect(epaResolved).toBe(true);
        expect(epa).toBe(epaItem);
        return okItem('aqueduct');
      }),
    });
    await gatherEvidence(fakeProduct(), fetchers);
    expect(fetchers.aqueduct).toHaveBeenCalledTimes(1);
  });
});
