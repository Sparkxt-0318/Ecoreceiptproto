// Stage 3 — Six-source parallel evidence gather.
//
// Five sources fire in parallel via Promise.allSettled with 4–5s
// AbortController timeouts. Aqueduct depends on EPA's first geocoded facility,
// so it runs in sequence after EPA settles. Total wall-clock is bounded by
// max(off, sec, news, brand) + max(epa→aqueduct).
//
// `degraded: true` is set when 3+ sources returned non-ok status. Stage 9 uses
// this to force confidence_grade='C'.

import type { LlmAnthropic } from './llm.js';
import { fetchAqueduct } from './sources/aqueduct.js';
import { fetchEpaEnvirofacts } from './sources/epa_envirofacts.js';
import { fetchNewsApi } from './sources/newsapi.js';
import { fetchOpenFoodFacts } from './sources/openfoodfacts.js';
import { fetchSecEdgar } from './sources/sec_edgar.js';
import { fetchBrandSite } from './sources/web_fetch.js';
import { buildItem, type Fetcher } from './sources/_base.js';
import type {
  EvidenceItem,
  EvidenceSource,
  Product,
  RawEvidence,
} from './types.js';

export type EvidenceFetchers = {
  openfoodfacts: (p: Product) => Promise<EvidenceItem>;
  sec_edgar: (p: Product) => Promise<EvidenceItem>;
  epa_envirofacts: (p: Product) => Promise<EvidenceItem>;
  newsapi: (p: Product) => Promise<EvidenceItem>;
  brand_site: (p: Product) => Promise<EvidenceItem>;
  aqueduct: (epaItem: EvidenceItem | null) => EvidenceItem | Promise<EvidenceItem>;
};

export function makeDefaultFetchers(
  fetcher: Fetcher = fetch,
  client?: LlmAnthropic,
): EvidenceFetchers {
  return {
    openfoodfacts: (p) => fetchOpenFoodFacts(p, fetcher),
    sec_edgar: (p) => fetchSecEdgar(p, fetcher),
    epa_envirofacts: (p) => fetchEpaEnvirofacts(p, fetcher),
    newsapi: (p) => fetchNewsApi(p, fetcher),
    // Brand-site fetcher uses the LLM client only when all HTTP candidates
    // fail (training-knowledge fallback). When client is undefined, the
    // fetcher returns 'empty' instead of falling back.
    brand_site: (p) => fetchBrandSite(p, { fetcher, client }),
    aqueduct: (epa) => fetchAqueduct(epa),
  };
}

function settledOrError(
  source: EvidenceSource,
  result: PromiseSettledResult<EvidenceItem>,
): EvidenceItem {
  if (result.status === 'fulfilled') return result.value;
  return buildItem({ source, status: 'error', data: { reason: String(result.reason) } });
}

export async function gatherEvidence(
  product: Product,
  fetchers: EvidenceFetchers = makeDefaultFetchers(),
): Promise<RawEvidence> {
  // Parallel: OFF, SEC, EPA, NewsAPI, BrandSite. Aqueduct waits for EPA.
  const [off, sec, epa, news, brand] = await Promise.allSettled([
    fetchers.openfoodfacts(product),
    fetchers.sec_edgar(product),
    fetchers.epa_envirofacts(product),
    fetchers.newsapi(product),
    fetchers.brand_site(product),
  ]);

  const offItem = settledOrError('openfoodfacts', off);
  const secItem = settledOrError('sec_edgar', sec);
  const epaItem = settledOrError('epa_envirofacts', epa);
  const newsItem = settledOrError('newsapi', news);
  const brandItem = settledOrError('brand_site', brand);

  const aqItem = await Promise.resolve(
    fetchers.aqueduct(epaItem.status === 'ok' ? epaItem : null),
  );

  const items: EvidenceItem[] = [
    offItem,
    secItem,
    epaItem,
    aqItem,
    newsItem,
    brandItem,
  ];
  const failures = items.filter((it) => it.status !== 'ok').length;
  return { items, degraded: failures >= 3 };
}
