// OpenFoodFacts product lookup. Tier 4 (brand-supplied).

import type { Product } from '../types.js';
import { buildItem, fetchWithTimeout, isAbortError, sha256Hex, type Fetcher } from './_base.js';

export async function fetchOpenFoodFacts(
  product: Product,
  fetcher: Fetcher = fetch,
) {
  const url = product.upc
    ? `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(product.upc)}.json`
    : `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(product.name)}&json=1&page_size=1`;

  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 4000 }, fetcher);
    if (!r.ok) {
      return buildItem({ source: 'openfoodfacts', status: 'error', url, data: null });
    }
    const text = await r.text();
    const json = JSON.parse(text) as { status?: number; product?: unknown; products?: unknown[] };
    const hasProduct =
      (json.status === 1 && json.product) ||
      (Array.isArray(json.products) && json.products.length > 0);
    if (!hasProduct) {
      return buildItem({
        source: 'openfoodfacts',
        status: 'empty',
        url,
        data: null,
        content_hash: sha256Hex(text),
      });
    }
    return buildItem({
      source: 'openfoodfacts',
      status: 'ok',
      url,
      data: json,
      content_hash: sha256Hex(text),
    });
  } catch (e) {
    return buildItem({
      source: 'openfoodfacts',
      status: isAbortError(e) ? 'timeout' : 'error',
      url,
      data: null,
    });
  }
}
