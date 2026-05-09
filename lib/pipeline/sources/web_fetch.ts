// Brand sustainability page fetch. Tier 4 — claim source, not rebuttal.
// Tries common paths in order; first 200-OK with substantive content wins.
//
// Acceptance is positive-signal based, not phrase-blacklist:
//   - text length ≥ 2000 chars: accept
//   - 500–2000 chars AND contains at least one ENV_SIGNAL_TERM: accept
//   - else: thin, try next candidate
//
// This rejects bot-protection / queue interstitials (e.g. Patagonia's "Hang
// Tight! Routing to checkout" page, ~1000 chars, zero environmental terms)
// without resorting to fragile keyword blocklists.

import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

// Expanded path list: typical CPG sustainability/ESG slugs across multiple
// CMS conventions. Order matters — most-common first.
const PATHS = [
  '/sustainability',
  '/esg',
  '/our-impact',
  '/responsibility',
  '/about/sustainability',
  '/sustainability/our-impact',
  '/our-footprint',
  '/environment',
  '/social-responsibility',
];

const MAX_TEXT_LENGTH = 12000;
const MAX_CANDIDATES = 8;

// Thin-content acceptance gate. See module header.
const ACCEPT_LENGTH = 2000;
const SIGNAL_LENGTH = 500;

const ENV_SIGNAL_TERMS = [
  'sustainab',
  'carbon',
  'recycl',
  'renewable',
  'emission',
  'footprint',
  'environment',
  'climate',
  'organic',
  'compost',
  'biodegrad',
  'fair trade',
  'b corp',
  'fsc ',
  'usda organic',
  'energy star',
];

function hasEnvironmentalSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return ENV_SIGNAL_TERMS.some((term) => lower.includes(term));
}

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

function buildCandidates(product: Product): string[] {
  const domain = product.manufacturer_domain;
  if (!domain) return [];

  // Both bare and www. variants. If the manufacturer_domain already starts
  // with "www.", flip the order (bare variant takes second place).
  const startsWithWww = domain.startsWith('www.');
  const bare = startsWithWww ? domain.slice(4) : domain;
  const wwwed = startsWithWww ? domain : `www.${domain}`;

  const candidates: string[] = [];
  if (product.esg_report_url) candidates.push(product.esg_report_url);

  for (const path of PATHS) {
    candidates.push(`https://${bare}${path}`);
    candidates.push(`https://${wwwed}${path}`);
  }

  // Dedupe (esg_report_url may already match one of the path variants) and cap.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    deduped.push(c);
    if (deduped.length >= MAX_CANDIDATES) break;
  }
  return deduped;
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
  const candidates = buildCandidates(product);
  dlog(`product=${product.name} candidates=${candidates.length}`);

  for (const url of candidates) {
    dlog(`try url=${url}`);
    try {
      const r = await fetchWithTimeout(
        url,
        {
          timeoutMs: 5000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; EcoReceipt/0.1; research@ecoreceipt.example)',
          },
          redirect: 'follow',
        },
        fetcher,
      );
      const contentLength = r.headers.get('content-length') ?? 'unknown';
      dlog(`  status=${r.status} content-length=${contentLength}`);
      if (!r.ok) continue;
      const html = await r.text();
      const text = htmlToText(html).slice(0, MAX_TEXT_LENGTH);
      const signal = hasEnvironmentalSignal(text);
      dlog(`  stripped_text_length=${text.length} env_signal=${signal}`);
      dlog(`  first_500_chars="${text.slice(0, 500).replace(/\n/g, ' ')}"`);

      const accept =
        text.length >= ACCEPT_LENGTH ||
        (text.length >= SIGNAL_LENGTH && signal);
      if (!accept) {
        dlog(
          `  → thin/non-content (length=${text.length} signal=${signal}), trying next`,
        );
        continue;
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
      // try next candidate
    }
  }
  dlog('exhausted all candidates → empty');
  return buildItem({
    source: 'brand_site',
    status: 'empty',
    data: { reason: 'no candidate returned substantive content' },
  });
}
