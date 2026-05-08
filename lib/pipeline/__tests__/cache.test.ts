// Cache tests (stage 2).

import { afterEach, describe, expect, it } from 'vitest';

import {
  cacheSize,
  clearCache,
  getCached,
  isoWeek,
  setCached,
} from '../cache.js';
import type { EcoReceipt } from '../types.js';

afterEach(() => clearCache());

function fakeReceipt(): EcoReceipt {
  return {
    product: {
      id: 'pid',
      name: 'X',
      manufacturer: 'M',
      category: 'food.condiment.ketchup',
    },
    status_badge: 'MIXED_SIGNALS',
    ecoscore: 50,
    sub_scores: {
      claim_integrity: 12,
      carbon_footprint: 12,
      material_sourcing: 12,
      end_of_life: 12,
    },
    headline_metrics: { co2e_kg: 1, water_l: 1, land_m2: 1 },
    verdicts: [],
    evidence_merkle_root: 'a'.repeat(64),
    confidence_grade: 'B',
    generated_at: '2026-05-08T00:00:00.000Z',
    pipeline_duration_ms: 100,
    pipeline_cost_usd: 0.01,
  };
}

describe('Stage 2: cache', () => {
  it('returns null on miss', () => {
    expect(getCached('nonexistent')).toBeNull();
  });

  it('round-trips a receipt within the same week', () => {
    const r = fakeReceipt();
    setCached('pid', r);
    expect(getCached('pid')).toEqual(r);
  });

  it('different product ids do not collide', () => {
    const a = fakeReceipt();
    setCached('pid-a', a);
    expect(getCached('pid-b')).toBeNull();
  });

  it('different weeks miss for the same product id', () => {
    const r = fakeReceipt();
    setCached('pid', r, '2026-W18');
    expect(getCached('pid', '2026-W19')).toBeNull();
    expect(getCached('pid', '2026-W18')).toEqual(r);
  });

  it('clearCache empties the store', () => {
    setCached('pid', fakeReceipt());
    expect(cacheSize()).toBe(1);
    clearCache();
    expect(cacheSize()).toBe(0);
  });

  it('isoWeek produces the conventional ISO format', () => {
    // 2026-05-08 is a Friday in week 19.
    expect(isoWeek(new Date('2026-05-08T12:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });
});
