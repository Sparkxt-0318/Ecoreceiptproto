// Shared helpers for evidence-source fetchers.
//
// Every source returns an EvidenceItem regardless of outcome. The orchestrator
// reads `status` to know whether the data is usable. Failure modes:
//   - timeout: AbortController fired before response arrived
//   - error:   network/HTTP error or thrown exception
//   - empty:   request succeeded but no useful data (404, empty body, missing API key)
//   - ok:      response received with usable content
//
// content_hash must always be a valid sha256-hex string for schema purposes.
// On non-ok, we fill it with a placeholder so the merkle tree still has a leaf
// per source even when the source failed (the leaf is "we tried, here's the
// timestamp of the failure").

import crypto from 'node:crypto';

import { SOURCE_TIERS } from '../data/source_tiers.js';
import type {
  EvidenceItem,
  EvidenceSource,
  EvidenceStatus,
} from '../types.js';

export const PLACEHOLDER_HASH = '0'.repeat(64);

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export type Fetcher = typeof fetch;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 4000);
  try {
    const r = await fetcher(url, { ...init, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

export function buildItem(args: {
  source: EvidenceSource;
  status: EvidenceStatus;
  url?: string;
  data: unknown;
  content_hash?: string;
  provenance?: 'llm_summary';
}): EvidenceItem {
  return {
    source: args.source,
    status: args.status,
    url: args.url,
    tier: SOURCE_TIERS[args.source],
    data: args.data,
    fetched_at: new Date().toISOString(),
    content_hash: args.content_hash ?? PLACEHOLDER_HASH,
    ...(args.provenance ? { provenance: args.provenance } : {}),
  };
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'));
}
