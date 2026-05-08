// NewsAPI search. Tier 5 — used as a lead, not a final source.
// Skipped entirely if NEWSAPI_KEY env var is missing.

import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

export async function fetchNewsApi(
  product: Product,
  fetcher: Fetcher = fetch,
  apiKey: string | undefined = process.env.NEWSAPI_KEY,
) {
  if (!apiKey) {
    return buildItem({
      source: 'newsapi',
      status: 'empty',
      data: { reason: 'no api key' },
    });
  }
  const q = encodeURIComponent(`"${product.manufacturer}" greenwashing OR lawsuit OR sustainability`);
  const url = `https://newsapi.org/v2/everything?q=${q}&pageSize=5&sortBy=relevancy`;
  try {
    const r = await fetchWithTimeout(
      url,
      { timeoutMs: 4000, headers: { 'X-Api-Key': apiKey } },
      fetcher,
    );
    if (!r.ok) {
      return buildItem({ source: 'newsapi', status: 'error', url, data: null });
    }
    const text = await r.text();
    const json = JSON.parse(text) as { articles?: Array<Record<string, unknown>> };
    const articles = json.articles ?? [];
    if (articles.length === 0) {
      return buildItem({
        source: 'newsapi',
        status: 'empty',
        url,
        data: null,
        content_hash: sha256Hex(text),
      });
    }
    const trimmed = articles.slice(0, 5).map((a) => ({
      title: a.title,
      url: a.url,
      source: (a.source as { name?: string } | undefined)?.name,
      publishedAt: a.publishedAt,
      description: a.description,
    }));
    return buildItem({
      source: 'newsapi',
      status: 'ok',
      url,
      data: { articles: trimmed },
      content_hash: sha256Hex(text),
    });
  } catch (e) {
    return buildItem({
      source: 'newsapi',
      status: isAbortError(e) ? 'timeout' : 'error',
      url,
      data: null,
    });
  }
}
