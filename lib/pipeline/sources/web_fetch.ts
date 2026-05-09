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

import {
  computeHaikuCost,
  extractText,
  getDefaultClient,
  HAIKU_MODEL,
  type LlmAnthropic,
} from '../llm.js';
import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

/**
 * Sentinel path component used in the URL of every LLM-summary fallback
 * evidence item. Stage 7 (validateVerdict) rejects any rebuttal that cites
 * a URL containing this token, ensuring training-knowledge content can never
 * pose as primary evidence.
 */
export const LLM_FALLBACK_TOKEN = '__llm_fallback__';

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

const LLM_SUMMARY_PROMPT = `Summarize the publicly known environmental and sustainability claims made by the named manufacturer about its products and operations.

Source: your training knowledge only. Do not invent specifics. If you have no concrete knowledge, output an empty string.

Format: plain text, ~500 words. Use short bulleted lines for individual claims/badges/certifications when applicable. Stay close to verifiable specifics — name certifications, numeric targets with their dates, recycled-content percentages, etc. Avoid marketing prose.`;

export type BrandSiteDeps = {
  fetcher?: Fetcher;
  client?: LlmAnthropic;
};

async function llmSummaryFallback(
  product: Product,
  client: LlmAnthropic,
): Promise<{ text: string; cost_usd: number }> {
  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 800,
      temperature: 0,
      system: LLM_SUMMARY_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Manufacturer: ${product.manufacturer}\nProduct: ${product.name}\nCategory: ${product.category}`,
        },
      ],
    });
    const cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
    const text = extractText(resp).trim();
    return { text, cost_usd: cost };
  } catch (e) {
    dlog(`  llm_fallback error: ${(e as Error).message}`);
    return { text: '', cost_usd: 0 };
  }
}

export async function fetchBrandSite(
  product: Product,
  fetcherOrDeps: Fetcher | BrandSiteDeps = fetch,
) {
  // Backwards-compatible signature: callers may pass a bare Fetcher (the
  // existing default) OR the structured BrandSiteDeps object when they want
  // to inject an LLM client for fallback synthesis.
  const fetcher: Fetcher =
    typeof fetcherOrDeps === 'function' ? fetcherOrDeps : fetcherOrDeps.fetcher ?? fetch;
  const client: LlmAnthropic | undefined =
    typeof fetcherOrDeps === 'function' ? undefined : fetcherOrDeps.client;

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
  dlog('exhausted all candidates; trying LLM-summary fallback');

  // All candidates failed — try the LLM-knowledge fallback so Stage 4 still
  // has something to extract claims from. The fallback URL contains
  // LLM_FALLBACK_TOKEN; Stage 7 rejects any verdict citing that pattern as
  // a rebuttal source, so this content can NEVER be used as primary evidence.
  if (!client) {
    dlog('no LLM client available → empty');
    return buildItem({
      source: 'brand_site',
      status: 'empty',
      data: { reason: 'no candidate returned substantive content; no llm fallback' },
    });
  }
  const { text: llmText } = await llmSummaryFallback(product, client);
  if (!llmText || llmText.length < SIGNAL_LENGTH) {
    dlog(`llm fallback returned ${llmText.length} chars → empty`);
    return buildItem({
      source: 'brand_site',
      status: 'empty',
      data: { reason: 'llm fallback returned empty/thin' },
    });
  }
  dlog(`llm fallback returned ${llmText.length} chars → accepted as fallback`);
  return buildItem({
    source: 'brand_site',
    status: 'ok',
    url: `https://${product.manufacturer_domain}/${LLM_FALLBACK_TOKEN}`,
    data: { text: llmText },
    content_hash: sha256Hex(llmText),
    provenance: 'llm_summary',
  });
}
