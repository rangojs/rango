/**
 * Shared Cache Policy Utilities
 *
 * Resolution cascades for TTL, SWR, cache key, and cache store.
 * Consolidates the multi-tier resolution pattern:
 *   explicit option → store defaults → fallback constant
 */

import type { CacheDefaults, SegmentCacheStore } from "./types.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../server/request-context.js";
import type { RequestContext } from "../server/request-context.js";

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

// ============================================================================
// Cache Key Resolution
// ============================================================================

/**
 * Resolve cache key using the 3-tier priority:
 * 1. keyFn (full override from route/loader cache options)
 * 2. store.keyGenerator (modifies default key)
 * 3. defaultKey (fallback)
 *
 * On error at any tier, falls through to the next rather than failing.
 */
export async function resolveCacheKey(
  keyFn: ((ctx: RequestContext) => string | Promise<string>) | undefined,
  store: SegmentCacheStore | null,
  defaultKey: string,
  label: string,
): Promise<string> {
  const requestCtx = getRequestContext();

  // Priority 1: Route/loader-level key function (full override)
  if (keyFn && requestCtx) {
    try {
      return await keyFn(requestCtx);
    } catch (error) {
      console.error(
        `[${label}] Custom key function failed, using default:`,
        error,
      );
    }
  }

  // Priority 2: Store-level keyGenerator (modifies default key)
  if (store?.keyGenerator && requestCtx) {
    try {
      return await store.keyGenerator(requestCtx, defaultKey);
    } catch (error) {
      console.error(
        `[${label}] Store keyGenerator failed, using default:`,
        error,
      );
    }
  }

  // Priority 3: Default key
  return defaultKey;
}

// ============================================================================
// Cache Store Resolution
// ============================================================================

/**
 * Resolve cache store from the 2-tier priority:
 * 1. Explicit store from cache options
 * 2. App-level store from request context
 */
export function resolveCacheStore(
  explicitStore: SegmentCacheStore | undefined,
): SegmentCacheStore | null {
  if (explicitStore) return explicitStore;
  return _getRequestContext()?._cacheStore ?? null;
}
