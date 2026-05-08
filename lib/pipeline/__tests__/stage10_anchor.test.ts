// Stage 10 (merkle anchor) tests.

import { describe, expect, it } from 'vitest';

import {
  anchorReceipt,
  hashReceiptBody,
  merkleRoot,
} from '../stage10_anchor.js';
import type { EcoReceipt, RawEvidence } from '../types.js';

function bufFromHex(h: string): Buffer {
  return Buffer.from(h, 'hex');
}

function fakeReceipt(overrides: Partial<EcoReceipt> = {}): EcoReceipt {
  return {
    product: { id: 'pid', name: 'X', manufacturer: 'M', category: 'c' },
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
    evidence_merkle_root: '',
    confidence_grade: 'B',
    generated_at: '2026-05-08T00:00:00.000Z',
    pipeline_duration_ms: 100,
    pipeline_cost_usd: 0.01,
    ...overrides,
  };
}

function fakeEvidence(hashes: string[]): RawEvidence {
  return {
    items: hashes.map((h, i) => ({
      source: 'openfoodfacts',
      status: 'ok',
      url: `https://x/${i}`,
      tier: 4,
      data: null,
      fetched_at: '2026-05-08T00:00:00.000Z',
      content_hash: h,
    })),
    degraded: false,
  };
}

describe('Stage 10: merkleRoot', () => {
  it('returns the leaf hash for a single-leaf tree', () => {
    const h = 'a'.repeat(64);
    expect(merkleRoot([bufFromHex(h)])).toBe(h);
  });

  it('is deterministic for same inputs', () => {
    const leaves = ['aa', 'bb', 'cc', 'dd'].map((c) => bufFromHex(c.repeat(32)));
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it('differs when any leaf changes', () => {
    const a = ['aa', 'bb', 'cc'].map((c) => bufFromHex(c.repeat(32)));
    const b = ['aa', 'bb', 'cd'].map((c) => bufFromHex(c.repeat(32)));
    expect(merkleRoot(a)).not.toBe(merkleRoot(b));
  });

  it('throws on empty leaves', () => {
    expect(() => merkleRoot([])).toThrow();
  });
});

describe('Stage 10: anchorReceipt', () => {
  it('produces a 64-char hex merkle root and a placeholder tx_hash', async () => {
    const evidence = fakeEvidence(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    const result = await anchorReceipt(fakeReceipt(), evidence);
    expect(result.merkle_root).toMatch(/^[a-f0-9]{64}$/);
    expect(result.tx_hash.startsWith('0x')).toBe(true);
    expect(result.mock).toBe(true);
  });

  it('produces different roots when evidence differs', async () => {
    const a = await anchorReceipt(fakeReceipt(), fakeEvidence(['a'.repeat(64)]));
    const b = await anchorReceipt(fakeReceipt(), fakeEvidence(['b'.repeat(64)]));
    expect(a.merkle_root).not.toBe(b.merkle_root);
  });

  it('hashReceiptBody ignores evidence_merkle_root field (avoids circular hash)', () => {
    const r1 = fakeReceipt({ evidence_merkle_root: '' });
    const r2 = fakeReceipt({ evidence_merkle_root: 'a'.repeat(64) });
    expect(hashReceiptBody(r1)).toBe(hashReceiptBody(r2));
  });
});
