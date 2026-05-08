// Stage 1 — Resolve canonical Product identity from text or image input.
//
// Text path:
//   1. Query OpenFoodFacts. If we get a product_name + brands, build Product directly.
//   2. Else: ask Haiku (training knowledge, no web search in MVP) for the
//      manufacturer/parent company + domain + category.
//   3. If neither path yields a manufacturer, throw InsufficientProductDataError.
//   4. Best-effort: probe manufacturer_domain for an ESG report URL.
//
// Image path:
//   1. Single Haiku vision call with the spec's verbatim system prompt.
//   2. confidence < 0.5 → throw.
//   3. Continue with the text path using the vision-returned name.
//
// All external calls (OFF fetch, ESG probe) are injectable for tests.

import crypto from 'node:crypto';

import {
  computeHaikuCost,
  extractText,
  getDefaultClient,
  HAIKU_MODEL,
  safeJsonParse,
  type LlmAnthropic,
} from './llm.js';
import {
  ProductCandidateSchema,
  ProductSchema,
} from './schemas.js';
import {
  InsufficientProductDataError,
  type PipelineInput,
  type Product,
  type ProductCandidate,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── OpenFoodFacts search (injectable) ───────────────────────────────────────

export type OffSearchResult = {
  product_name: string;
  brands: string;
  upc?: string;
  categories?: string;
  image_url?: string;
} | null;

export type OffSearcher = (query: string) => Promise<OffSearchResult>;

export const defaultOffSearcher: OffSearcher = async (query) => {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      products?: Array<{
        product_name?: string;
        brands?: string;
        code?: string;
        categories?: string;
        image_url?: string;
      }>;
    };
    const p = json.products?.[0];
    if (!p?.product_name || !p?.brands) return null;
    return {
      product_name: p.product_name,
      brands: p.brands,
      upc: p.code,
      categories: p.categories,
      image_url: p.image_url,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ─── ESG-report probe (injectable) ───────────────────────────────────────────

export type EsgProbe = (domain: string) => Promise<string | null>;

export const defaultEsgProbe: EsgProbe = async (domain) => {
  const paths = ['/sustainability', '/esg', '/our-impact', '/responsibility'];
  for (const p of paths) {
    const url = `https://${domain}${p}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (resp.ok) return url;
    } catch {
      // try next
    }
  }
  return null;
};

// ─── LLM lookups ─────────────────────────────────────────────────────────────

const VISION_SYSTEM = `You identify retail consumer products from photos.

Rules:
- Output JSON only, no prose.
- If you cannot identify the specific product brand and name with high confidence, set confidence to 0 and leave other fields empty.
- Never guess a brand name from packaging style alone.

Return: {name, manufacturer_guess, category_guess, confidence}
where confidence ∈ [0, 1].`;

async function visionIdentify(
  image: Buffer,
  client: LlmAnthropic,
): Promise<{ candidate: ProductCandidate | null; cost_usd: number }> {
  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: VISION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: image.toString('base64'),
            },
          },
          { type: 'text', text: 'Identify this product.' },
        ],
      },
    ],
  });
  const cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
  const parsed = safeJsonParse(extractText(resp));
  const validated = ProductCandidateSchema.safeParse(parsed);
  return {
    candidate: validated.success ? validated.data : null,
    cost_usd: cost,
  };
}

const MANUFACTURER_LOOKUP_PROMPT = `You answer questions about who makes consumer products. Use only your training knowledge.

Output JSON only:
{"manufacturer": "<parent company>", "manufacturer_domain": "<example.com>", "category_guess": "<dotted.category.path>"}

If you do not know with high confidence, output:
{"manufacturer": null, "manufacturer_domain": null, "category_guess": null}

Do not guess. "I don't know" is acceptable.`;

async function lookupManufacturer(
  productName: string,
  client: LlmAnthropic,
): Promise<{
  manufacturer: string | null;
  manufacturer_domain: string | null;
  category_guess: string | null;
  cost_usd: number;
}> {
  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: MANUFACTURER_LOOKUP_PROMPT,
    messages: [{ role: 'user', content: `Who makes: ${productName}` }],
  });
  const cost = computeHaikuCost(resp.usage.input_tokens, resp.usage.output_tokens);
  const parsed = safeJsonParse<{
    manufacturer: string | null;
    manufacturer_domain: string | null;
    category_guess: string | null;
  }>(extractText(resp));
  return {
    manufacturer: parsed?.manufacturer ?? null,
    manufacturer_domain: parsed?.manufacturer_domain ?? null,
    category_guess: parsed?.category_guess ?? null,
    cost_usd: cost,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type ResolveDeps = {
  client?: LlmAnthropic;
  offSearcher?: OffSearcher;
  esgProbe?: EsgProbe;
};

export type ResolveResult = {
  product: Product;
  cost_usd: number;
  duration_ms: number;
};

export async function resolveProduct(
  input: PipelineInput,
  deps: ResolveDeps = {},
): Promise<ResolveResult> {
  const t0 = Date.now();
  const client = deps.client ?? getDefaultClient();
  const off = deps.offSearcher ?? defaultOffSearcher;
  const esgProbe = deps.esgProbe ?? defaultEsgProbe;

  let cost = 0;
  let queryName: string;

  // Image path: vision first, then fall through to text path with the name.
  if (input.kind === 'image') {
    const vision = await visionIdentify(input.value, client);
    cost += vision.cost_usd;
    if (!vision.candidate || vision.candidate.confidence < 0.5) {
      throw new InsufficientProductDataError(
        `image identification confidence ${vision.candidate?.confidence ?? 0} < 0.5`,
      );
    }
    queryName = vision.candidate.name;
  } else {
    queryName = input.value;
  }

  // Text path: try OFF first.
  let manufacturer: string | undefined;
  let manufacturer_domain: string | undefined;
  let upc: string | undefined;
  let category: string | undefined;
  let canonical_name: string = queryName;
  let product_image_url: string | undefined;

  const offResult = await off(queryName);
  if (offResult) {
    canonical_name = offResult.product_name;
    manufacturer = offResult.brands.split(',')[0]?.trim();
    upc = offResult.upc;
    category = offResult.categories?.split(',')[0]?.trim().toLowerCase().replace(/\s+/g, '.');
    product_image_url = offResult.image_url;
  }

  // If OFF didn't give us a manufacturer, ask the LLM.
  if (!manufacturer) {
    const lookup = await lookupManufacturer(queryName, client);
    cost += lookup.cost_usd;
    if (lookup.manufacturer) {
      manufacturer = lookup.manufacturer;
      manufacturer_domain = lookup.manufacturer_domain ?? undefined;
      category = category ?? lookup.category_guess ?? undefined;
    }
  }

  if (!manufacturer) {
    throw new InsufficientProductDataError(
      `could not resolve manufacturer for "${queryName}"`,
    );
  }

  // Best-effort ESG probe.
  let esg_report_url: string | undefined;
  if (manufacturer_domain) {
    const found = await esgProbe(manufacturer_domain);
    if (found) esg_report_url = found;
  }

  // Build canonical Product.
  const candidate: Product = {
    id: sha256(normalizeName(canonical_name)),
    name: canonical_name,
    manufacturer,
    upc,
    category: category ?? 'unknown',
    manufacturer_domain,
    esg_report_url,
    product_image_url,
  };
  const product = ProductSchema.parse(candidate);

  return { product, cost_usd: cost, duration_ms: Date.now() - t0 };
}
