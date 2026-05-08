// Stage 10 — Merkle anchoring + Monad mint stub.
//
// Builds a real merkle tree over every EvidenceItem.content_hash plus the
// receipt body hash. mintReceipt() is stubbed — real Monad chain integration
// is post-MVP — but the tree itself is honest, so when the real mint lands
// it gets a precomputed root and matching proofs.

import crypto from 'node:crypto';

import type { EcoReceipt, RawEvidence } from './types.js';

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Build a binary merkle tree from leaves (32-byte buffers). Returns the root
 * as lowercase hex. Uses sorted-pair hashing so order doesn't matter to
 * verifiers (matches the OpenZeppelin convention).
 *
 * For a single leaf, root = that leaf. Empty leaves throws — caller should
 * always pass at least one (the receipt body hash).
 */
export function merkleRoot(leaves: Buffer[]): string {
  if (leaves.length === 0) throw new Error('merkleRoot: cannot build tree from zero leaves');
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i]!;
      const b = layer[i + 1] ?? a; // duplicate last on odd count
      const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
      next.push(crypto.createHash('sha256').update(Buffer.concat([lo, hi])).digest());
    }
    layer = next;
  }
  return layer[0]!.toString('hex');
}

/**
 * Hash the receipt body, excluding `evidence_merkle_root` (which we're about
 * to compute and would create a circular dependency).
 */
export function hashReceiptBody(receipt: EcoReceipt): string {
  const { evidence_merkle_root: _ignore, ...body } = receipt;
  return sha256Hex(JSON.stringify(body));
}

export type AnchorResult = {
  merkle_root: string;
  receipt_hash: string;
  tx_hash: string;
  mock: true;
};

export async function anchorReceipt(
  receipt: EcoReceipt,
  evidence: RawEvidence,
): Promise<AnchorResult> {
  const receiptHash = hashReceiptBody(receipt);
  const leafHashes = [receiptHash, ...evidence.items.map((it) => it.content_hash)];
  const root = merkleRoot(leafHashes.map(hexToBuf));

  // Stubbed Monad mint. Real implementation lives elsewhere.
  // eslint-disable-next-line no-console
  console.log('[stage10] would mint:', { merkle_root: root, receipt_hash: receiptHash });

  return {
    merkle_root: root,
    receipt_hash: receiptHash,
    tx_hash: '0x' + 'a'.repeat(64),
    mock: true,
  };
}
