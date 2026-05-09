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

const DEBUG = process.env.PIPELINE_DEBUG === '1';
function dlog(...args: unknown[]): void {
  if (DEBUG) console.error('[stage3:brand_site]', ...args);
}

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

  dlog(`product=${product.name} candidates=${candidates.length}`);

  for (const url of candidates) {
    dlog(`try url=${url}`);
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
      const contentLength = r.headers.get('content-length') ?? 'unknown';
      dlog(`  status=${r.status} content-length=${contentLength}`);
      if (!r.ok) continue;
      const html = await r.text();
      const text = htmlToText(html).slice(0, MAX_TEXT_LENGTH);
      dlog(`  stripped_text_length=${text.length}`);
      dlog(`  first_500_chars="${text.slice(0, 500).replace(/\n/g, ' ')}"`);
      if (text.length < 100) {
        dlog('  → thin content (<100 chars), trying next path');
        continue; // not a real content page
      }
      dlog(`  → accepted, returning text`);
      return buildItem({
        source: 'brand_site',
        status: 'ok',
        url,
        data: { text },
        content_hash: sha256Hex(html),
      });
    } catch (e) {
      if (isAbortError(e)) {
        dlog(`  → timeout`);
        return buildItem({ source: 'brand_site', status: 'timeout', url, data: null });
      }
      dlog(`  → error: ${(e as Error).message}`);
      // try next path
    }
  }
  dlog('exhausted all candidates → empty');
  return buildItem({
    source: 'brand_site',
    status: 'empty',
    data: { reason: 'no path returned content' },
  });
}
