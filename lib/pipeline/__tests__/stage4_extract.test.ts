// Stage 4 (claim extraction) tests. Mocks the Anthropic client at the
// `messages.create` boundary.

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { extractClaims } from '../stage4_extract.js';
import type { Product } from '../types.js';

function fakeProduct(): Product {
  return {
    id: 'pid',
    name: 'Heinz Tomato Ketchup 14oz',
    manufacturer: 'Kraft Heinz',
    category: 'food.condiment.ketchup',
  };
}

function fakeMessage(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  } as unknown as Anthropic.Messages.Message;
}

function fakeClient(message: Anthropic.Messages.Message) {
  return {
    messages: { create: vi.fn().mockResolvedValue(message) },
  } as unknown as Anthropic;
}

describe('Stage 4: extractClaims', () => {
  it('returns [] immediately when brand site content is empty (no LLM call)', async () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;

    const result = await extractClaims(fakeProduct(), '', 'https://example.com', client);

    expect(result.claims).toEqual([]);
    expect(result.cost_usd).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns [] (without throwing) when LLM emits non-JSON garbage', async () => {
    const client = fakeClient(fakeMessage('not json at all, just prose'));

    const result = await extractClaims(
      fakeProduct(),
      'Some brand copy.',
      'https://example.com',
      client,
    );

    expect(result.claims).toEqual([]);
    expect(result.cost_usd).toBeGreaterThan(0); // we did pay for the call
  });

  it('parses well-formed claims and stamps source_hash + retrieval_date', async () => {
    const json = JSON.stringify([
      {
        id: 'claim-1',
        quote: 'Made with 70% recycled materials.',
        type_hint: 'quantitative',
        source_url: 'https://kraftheinz.com/sustainability',
      },
      {
        id: 'claim-2',
        quote: 'Tomatoes sourced from California.',
        type_hint: 'factual',
        source_url: 'https://kraftheinz.com/sustainability',
      },
    ]);
    const client = fakeClient(fakeMessage(json));
    const content = 'Made with 70% recycled materials. Tomatoes sourced from California.';

    const result = await extractClaims(
      fakeProduct(),
      content,
      'https://kraftheinz.com/sustainability',
      client,
    );

    expect(result.claims).toHaveLength(2);
    const c1 = result.claims[0]!;
    expect(c1.id).toBe('claim-1');
    expect(c1.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(c1.retrieval_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // hash is deterministic for the same content
    expect(result.claims[1]!.source_hash).toBe(c1.source_hash);
  });

  it('survives code-fenced LLM output by stripping fences before parsing', async () => {
    const fenced = '```json\n[]\n```';
    const client = fakeClient(fakeMessage(fenced));

    const result = await extractClaims(
      fakeProduct(),
      'irrelevant copy',
      'https://example.com',
      client,
    );

    expect(result.claims).toEqual([]);
  });

  it('drops individual claims that fail schema validation but keeps valid ones', async () => {
    // claim-1 valid; claim-2 has a bad id format that ClaimSchema regex rejects.
    const json = JSON.stringify([
      {
        id: 'claim-1',
        quote: 'FSC certified packaging.',
        type_hint: 'certification',
        source_url: 'https://example.com/sustainability',
      },
      {
        id: 'foo-bar',
        quote: 'eco friendly',
        type_hint: 'qualitative',
        source_url: 'https://example.com/sustainability',
      },
    ]);
    const client = fakeClient(fakeMessage(json));

    const result = await extractClaims(
      fakeProduct(),
      'FSC certified packaging. eco friendly',
      'https://example.com/sustainability',
      client,
    );

    // RawClaimsArraySchema.safeParse rejects the entire array on any element
    // failing — that's the conservative path. So both go.
    expect(result.claims).toHaveLength(0);
  });

  it('computes cost from token usage with Haiku rates', async () => {
    // 1M input + 1M output should cost exactly $1 + $5 = $6
    const client = fakeClient(fakeMessage('[]', 1_000_000, 1_000_000));
    const result = await extractClaims(
      fakeProduct(),
      'copy',
      'https://example.com',
      client,
    );
    expect(result.cost_usd).toBeCloseTo(6, 5);
  });
});
