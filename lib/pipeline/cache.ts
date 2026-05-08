// Stage 2 — In-memory cache. MVP only. Redis lands post-MVP.
//
// Key format: `{product_id}:{ISO_week}`. Same product within the same ISO
// week (Monday-anchored) returns the cached receipt; new week busts.
// This is a cost-control mechanism — Heinz Ketchup queries on Monday and
// Tuesday share a receipt; Heinz Ketchup queries across a week boundary
// pay for a fresh audit.

import type { EcoReceipt } from './types.js';

const STORE = new Map<string, EcoReceipt>();

/** ISO 8601 week string for the supplied Date (defaults to now). */
export function isoWeek(d: Date = new Date()): string {
  // Per ISO 8601: weeks start on Monday; week 1 contains the year's first
  // Thursday. The trick below shifts the date to the Thursday of its week,
  // then divides days-since-Jan-1.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function buildKey(productId: string, week: string = isoWeek()): string {
  return `${productId}:${week}`;
}

export function getCached(productId: string, week: string = isoWeek()): EcoReceipt | null {
  return STORE.get(buildKey(productId, week)) ?? null;
}

export function setCached(
  productId: string,
  receipt: EcoReceipt,
  week: string = isoWeek(),
): void {
  STORE.set(buildKey(productId, week), receipt);
}

export function clearCache(): void {
  STORE.clear();
}

/** For tests/observability. */
export function cacheSize(): number {
  return STORE.size;
}
