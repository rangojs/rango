/**
 * Shared Cache Policy Utilities
 *
 * TTL/SWR resolution and expiration timestamp math.
 * Consolidates the resolution cascade:
 *   explicit option → store defaults → fallback constant
 */

import type { CacheDefaults } from "./types.js";

/**
 * Default TTL for route-level cache() DSL and loader cache.
 * Applied when neither the cache options nor the store defaults specify a TTL.
 */
export const DEFAULT_ROUTE_TTL = 60;

/**
 * Default TTL for function-level "use cache" (setItem).
 * Applied when neither the item options nor the store defaults specify a TTL.
 */
export const DEFAULT_FUNCTION_TTL = 900;

/**
 * Resolve effective TTL from the 3-tier cascade:
 * explicit → store defaults → fallback.
 */
export function resolveTtl(
  explicit: number | undefined,
  defaults: CacheDefaults | undefined,
  fallback: number,
): number {
  if (explicit !== undefined) return explicit;
  if (defaults?.ttl !== undefined) return defaults.ttl;
  return fallback;
}

/**
 * Resolve effective SWR window from the 2-tier cascade:
 * explicit → store defaults.
 * Returns 0 when unset (no SWR window).
 */
export function resolveSwrWindow(
  explicit: number | undefined,
  defaults: CacheDefaults | undefined,
): number {
  if (explicit !== undefined) return explicit;
  if (defaults?.swr !== undefined) return defaults.swr;
  return 0;
}

/**
 * Compute staleAt and expiresAt timestamps from TTL and SWR window.
 *
 * - staleAt: when the entry becomes stale (TTL boundary)
 * - expiresAt: when the entry should be evicted (TTL + SWR)
 *
 * When swrWindow is 0, staleAt === expiresAt (no SWR).
 */
export function computeExpiration(
  ttlSeconds: number,
  swrSeconds: number = 0,
): { staleAt: number; expiresAt: number } {
  const now = Date.now();
  const staleAt = now + ttlSeconds * 1000;
  const expiresAt = staleAt + swrSeconds * 1000;
  return { staleAt, expiresAt };
}
