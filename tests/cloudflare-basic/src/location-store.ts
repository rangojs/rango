// Two edge locations inside one worker, for the cross-location e2e
// (location-kv-fall-through.test.ts). A real location is its own Cache API
// (L1) over the one KV namespace every location reads. CFCacheStore's
// `namespace` scopes only the Cache API (caches.open(namespace)) and the
// isolate memos; KV entry and tag-marker keys carry no namespace. So two
// stores with different namespaces over ONE KV binding behave as two
// locations, and the request picks which one it is with a header.
//
// Same module-singleton wrapper shape as purge-store.ts: CFCacheStore needs
// the request's ExecutionContext, so each call delegates to a per-request
// store resolved from the live request context.
import { getRequestContext } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheGetResult,
  CacheReadError,
  CacheItemResult,
  CacheItemOptions,
} from "@rangojs/router/cache";
import type { AppBindings } from "./env.js";

export const LOCATION_HEADER = "x-test-location";
/** `off` builds the store without kvFallThrough, the option's default. */
export const FALL_THROUGH_HEADER = "x-test-kv-fall-through";

/** Renders per run id: the e2e asserts a location served without rendering. */
export const locationRenders = new Map<string, number>();

const perRequest = new WeakMap<object, CFCacheStore>();

function resolveStore(): CFCacheStore {
  const ctx = getRequestContext<AppBindings>();
  let store = perRequest.get(ctx);
  if (!store) {
    const location = ctx.request.headers.get(LOCATION_HEADER) ?? "default";
    store = new CFCacheStore({
      namespace: `location-e2e-${location}`,
      defaults: { ttl: 60, swr: 300 },
      ctx: ctx.executionContext!,
      kv: ctx.env.KV,
      kvFallThrough: ctx.request.headers.get(FALL_THROUGH_HEADER) !== "off",
    });
    perRequest.set(ctx, store);
  }
  return store;
}

// The response family is what a path.json route caches through; the other
// families delegate too so the wrapper never reads as "never caches".
export const locationStore: SegmentCacheStore = {
  get: (key: string): Promise<CacheGetResult | null | CacheReadError> =>
    resolveStore().get(key),
  set: (
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> => resolveStore().set(key, data, ttl, swr),
  delete: (key: string): Promise<boolean> => resolveStore().delete(key),
  getResponse: (
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> =>
    resolveStore().getResponse(key),
  putResponse: (
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> => resolveStore().putResponse(key, response, ttl, swr, tags),
  getItem: (key: string): Promise<CacheItemResult | null> =>
    resolveStore().getItem(key),
  setItem: (
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> => resolveStore().setItem(key, value, options),
  invalidateTags: (tags: string[]): Promise<void> =>
    resolveStore().invalidateTags(tags),
  isTagsInvalidatedSince: (tags: string[], sinceMs: number): Promise<boolean> =>
    resolveStore().isTagsInvalidatedSince(tags, sinceMs),
};
