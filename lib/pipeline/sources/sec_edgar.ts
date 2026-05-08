// SEC EDGAR full-text search. Tier 1 (regulatory filings).
// SEC requires a User-Agent header per their fair-use guidelines.

import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

const USER_AGENT = 'EcoReceipt MVP research@ecoreceipt.example';

export async function fetchSecEdgar(
  product: Product,
  fetcher: Fetcher = fetch,
) {
  const q = encodeURIComponent(`"${product.manufacturer}" sustainability`);
  const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=10-K`;
  try {
    const r = await fetchWithTimeout(
      url,
      {
        timeoutMs: 4000,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      },
      fetcher,
    );
    if (!r.ok) {
      return buildItem({ source: 'sec_edgar', status: 'error', url, data: null });
    }
    const text = await r.text();
    const json = JSON.parse(text) as {
      hits?: { hits?: Array<{ _source?: unknown; _id?: string }> };
    };
    const hits = json.hits?.hits ?? [];
    if (hits.length === 0) {
      return buildItem({
        source: 'sec_edgar',
        status: 'empty',
        url,
        data: null,
        content_hash: sha256Hex(text),
      });
    }
    return buildItem({
      source: 'sec_edgar',
      status: 'ok',
      url,
      data: { hits: hits.slice(0, 3) },
      content_hash: sha256Hex(text),
    });
  } catch (e) {
    return buildItem({
      source: 'sec_edgar',
      status: isAbortError(e) ? 'timeout' : 'error',
      url,
      data: null,
    });
  }
}
