/**
 * Shared Cache Policy Utilities
 *
 * Resolution cascades for TTL, SWR, cache key, and cache store.
 * Consolidates the multi-tier resolution pattern:
 *   explicit option → store defaults → fallback constant
 */

import type { CacheDefaults, SegmentCacheStore } from "./types.js";
import { _getRequestContext } from "../server/request-context.js";
import type { RequestContext } from "../server/request-context.js";
import { normalizeTags } from "./cache-tag.js";

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

export async function resolveCacheKey(
  keyFn: ((ctx: RequestContext) => string | Promise<string>) | undefined,
  store: SegmentCacheStore | null,
  defaultKey: string,
  _label: string,
): Promise<string> {
  const requestCtx = _getRequestContext();

  if (keyFn && requestCtx) {
    return await keyFn(requestCtx);
  }

  if (store?.keyGenerator && requestCtx) {
    return await store.keyGenerator(requestCtx, defaultKey);
  }

  return defaultKey;
}

export function resolveTagsOption<TEnv>(
  tags: string[] | ((ctx: RequestContext<TEnv>) => string[]) | undefined,
  ctx: RequestContext<TEnv> | undefined,
  label: string,
): string[] | undefined {
  if (!tags) return undefined;
  if (typeof tags === "function") {
    if (!ctx) {
      console.warn(
        `[${label}] Dynamic tags function present but no request context; ` +
          `caching without tags (this entry will not be tag-invalidatable).`,
      );
      return undefined;
    }
    try {
      return normalizeTagList(tags(ctx));
    } catch (error) {
      console.error(
        `[${label}] Tags function failed, caching without tags:`,
        error,
      );
      return undefined;
    }
  }
  return normalizeTagList(tags);
}

/**
 * Normalize a resolved tags array so the WRITE path matches the invalidate path:
 * updateTag()/revalidateTag()/cacheTag() all drop empty/whitespace-only tags via
 * normalizeTag(). Without this, an empty tag attached at write time would enter
 * the store index but could never be invalidated (the verbs normalize it away),
 * and on CFCacheStore would also cost a wasted KV marker read per request.
 * Returns undefined when nothing usable remains, keeping the entry header-free.
 */
function normalizeTagList(tags: string[]): string[] | undefined {
  const out = normalizeTags(tags);
  return out.length > 0 ? out : undefined;
}

export function resolveCacheStore(
  explicitStore: SegmentCacheStore | undefined,
): SegmentCacheStore | null {
  if (explicitStore) {
    registerExplicitTaggedStore(explicitStore);
    return explicitStore;
  }
  return _getRequestContext()?._cacheStore ?? null;
}

/**
 * Upper bound on the per-handler explicit-store registry. A module-singleton
 * store (the recommended pattern) dedupes to a single entry and never approaches
 * this. The cap bounds the niche case of an explicit store constructed PER
 * request/boundary (e.g. a ctx-bound CFCacheStore, which must take a per-request
 * ctx): without it the registry - which intentionally persists across requests so
 * a server action's updateTag() can reach stores a prior render registered -
 * would accumulate one dead instance per request and fan invalidation out to
 * finished execution contexts. LRU-touch on re-resolution keeps a live, re-used
 * store from being evicted by that churn.
 */
const EXPLICIT_STORE_REGISTRY_CAP = 64;

function registerExplicitTaggedStore(store: SegmentCacheStore): void {
  const set = _getRequestContext()?._explicitTaggedStores;
  if (!set) return;
  // LRU touch: move an already-present store to the most-recent position (Set
  // preserves insertion order) so a store re-resolved every request stays live.
  set.delete(store);
  set.add(store);
  if (set.size > EXPLICIT_STORE_REGISTRY_CAP) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}
