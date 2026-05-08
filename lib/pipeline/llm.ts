// Shared Anthropic client + cost helpers.
//
// All LLM-using stages take a client as an optional last arg defaulting to
// getDefaultClient() so tests can inject mocks without module-level vi.mock.
//
// Cost numbers (Haiku-4-5 published rates as of MVP build):
//   input:  $1.00 per 1M tokens
//   output: $5.00 per 1M tokens

import Anthropic from '@anthropic-ai/sdk';

let _default: Anthropic | null = null;

export function getDefaultClient(): Anthropic {
  if (!_default) {
    _default = new Anthropic();
  }
  return _default;
}

export const HAIKU_MODEL = 'claude-haiku-4-5';

export const HAIKU_INPUT_USD_PER_MTOK = 1.0;
export const HAIKU_OUTPUT_USD_PER_MTOK = 5.0;

export function computeHaikuCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK
  );
}

/** Strip Markdown code fences from a JSON-ish LLM response. */
export function stripCodeFences(text: string): string {
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m;
  const m = text.match(fence);
  return m && m[1] ? m[1].trim() : text.trim();
}

/** Extract the assembled text from an Anthropic Messages response. */
export function extractText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Parse JSON from an LLM response, tolerating code fences. Returns null on failure. */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch {
    return null;
  }
}

export type LlmAnthropic = Anthropic;
