// Stage 1 (resolve product) tests. Both OFF and the LLM client are
// injected so the test never touches real APIs.

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { resolveProduct } from '../stage1_resolve.js';
import { InsufficientProductDataError } from '../types.js';

function fakeClient(jsonResponse: unknown) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(jsonResponse) }],
    usage: { input_tokens: 50, output_tokens: 20 },
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('Stage 1: resolveProduct (text input)', () => {
  it('resolves via OpenFoodFacts hit without calling the LLM', async () => {
    const offSearcher = vi.fn().mockResolvedValue({
      product_name: 'Heinz Tomato Ketchup',
      brands: 'Heinz, Kraft Heinz',
      upc: '0013000005678',
      categories: 'Condiments, Ketchup',
      image_url: 'https://images.openfoodfacts.org/x.jpg',
    });
    const { client, create } = fakeClient({});
    const esgProbe = vi.fn().mockResolvedValue(null);

    const result = await resolveProduct(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      { client, offSearcher, esgProbe },
    );

    expect(create).not.toHaveBeenCalled();
    expect(result.product.manufacturer).toBe('Heinz');
    expect(result.product.upc).toBe('0013000005678');
    expect(result.product.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.cost_usd).toBe(0);
  });

  it('falls back to LLM manufacturer lookup when OFF returns no match', async () => {
    const offSearcher = vi.fn().mockResolvedValue(null);
    const { client, create } = fakeClient({
      manufacturer: 'Patagonia, Inc.',
      manufacturer_domain: 'patagonia.com',
      category_guess: 'apparel.fleece.synthetic',
    });
    const esgProbe = vi.fn().mockResolvedValue('https://patagonia.com/sustainability');

    const result = await resolveProduct(
      { kind: 'text', value: 'Patagonia Better Sweater Fleece Jacket' },
      { client, offSearcher, esgProbe },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.product.manufacturer).toBe('Patagonia, Inc.');
    expect(result.product.manufacturer_domain).toBe('patagonia.com');
    expect(result.product.esg_report_url).toBe('https://patagonia.com/sustainability');
  });

  it('throws InsufficientProductDataError when both OFF and LLM lookup fail', async () => {
    const offSearcher = vi.fn().mockResolvedValue(null);
    const { client } = fakeClient({
      manufacturer: null,
      manufacturer_domain: null,
      category_guess: null,
    });
    const esgProbe = vi.fn().mockResolvedValue(null);

    await expect(
      resolveProduct(
        { kind: 'text', value: 'qzqzqzqz unknown garbage' },
        { client, offSearcher, esgProbe },
      ),
    ).rejects.toThrow(InsufficientProductDataError);
  });

  it('produces a deterministic product.id for the same input name', async () => {
    const offSearcher = vi.fn().mockResolvedValue({
      product_name: 'Heinz Tomato Ketchup',
      brands: 'Heinz',
    });
    const { client } = fakeClient({});
    const esgProbe = vi.fn().mockResolvedValue(null);

    const a = await resolveProduct(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      { client, offSearcher, esgProbe },
    );
    const b = await resolveProduct(
      { kind: 'text', value: 'Heinz Tomato Ketchup 14oz' },
      { client, offSearcher, esgProbe },
    );
    expect(a.product.id).toBe(b.product.id);
  });
});

describe('Stage 1: resolveProduct (image input)', () => {
  it('throws when vision confidence < 0.5', async () => {
    const create = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: '',
            manufacturer_guess: '',
            category_guess: '',
            confidence: 0.2,
          }),
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 50 },
    });
    const client = { messages: { create } } as unknown as Anthropic;

    await expect(
      resolveProduct(
        { kind: 'image', value: Buffer.from('fakejpegbytes') },
        { client, offSearcher: vi.fn(), esgProbe: vi.fn() },
      ),
    ).rejects.toThrow(InsufficientProductDataError);
  });

  it('continues to text path when vision confidence >= 0.5', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: 'Heinz Tomato Ketchup',
              manufacturer_guess: 'Heinz',
              category_guess: 'food.condiment',
              confidence: 0.9,
            }),
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 50 },
      });
    const client = { messages: { create } } as unknown as Anthropic;
    const offSearcher = vi.fn().mockResolvedValue({
      product_name: 'Heinz Tomato Ketchup',
      brands: 'Heinz',
    });
    const esgProbe = vi.fn().mockResolvedValue(null);

    const result = await resolveProduct(
      { kind: 'image', value: Buffer.from('fakejpegbytes') },
      { client, offSearcher, esgProbe },
    );

    expect(create).toHaveBeenCalledTimes(1); // only vision; OFF hit means no manufacturer LLM call
    expect(result.product.manufacturer).toBe('Heinz');
    expect(result.cost_usd).toBeGreaterThan(0); // we paid for vision
  });
});
