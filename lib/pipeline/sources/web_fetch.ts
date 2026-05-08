// Brand sustainability page fetch. Tier 4 — claim source, not rebuttal.
// Tries common paths in order; first 200-OK with non-empty body wins.

import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

const PATHS = ['/sustainability', '/esg', '/our-impact', '/responsibility'];
const MAX_TEXT_LENGTH = 8000;

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchBrandSite(
  product: Product,
  fetcher: Fetcher = fetch,
) {
  if (!product.manufacturer_domain) {
    return buildItem({
      source: 'brand_site',
      status: 'empty',
      data: { reason: 'no manufacturer_domain' },
    });
  }
  const candidates = product.esg_report_url
    ? [product.esg_report_url, ...PATHS.map((p) => `https://${product.manufacturer_domain}${p}`)]
    : PATHS.map((p) => `https://${product.manufacturer_domain}${p}`);

  for (const url of candidates) {
    try {
      const r = await fetchWithTimeout(
        url,
        {
          timeoutMs: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0 EcoReceipt' },
          redirect: 'follow',
        },
        fetcher,
      );
      if (!r.ok) continue;
      const html = await r.text();
      const text = htmlToText(html).slice(0, MAX_TEXT_LENGTH);
      if (text.length < 100) continue; // not a real content page
      return buildItem({
        source: 'brand_site',
        status: 'ok',
        url,
        data: { text },
        content_hash: sha256Hex(html),
      });
    } catch (e) {
      if (isAbortError(e)) {
        return buildItem({ source: 'brand_site', status: 'timeout', url, data: null });
      }
      // try next path
    }
  }
  return buildItem({
    source: 'brand_site',
    status: 'empty',
    data: { reason: 'no path returned content' },
  });
}
