// Purge-mode CFCacheStore for the cache-tag-purge e2e, kept OFF the app-level
// store: purge mode changes read semantics (L1 hits skip the KV marker
// lookup), so wiring tagPurge on the app store would silently rewrite what the
// marker-mode cache-tag e2e pins. Instead the purge routes opt in via
// cache({ store: purgeModeStore }).
//
// CFCacheStore is ctx-bound (it needs the request's ExecutionContext for
// waitUntil), so a module-scope instance is impossible. This wrapper is the
// recommended module-singleton shape for cache({ store }) — it registers ONCE
// in the explicit-tagged-store registry (see cache-policy.ts
// EXPLICIT_STORE_REGISTRY_CAP) — and delegates each call to a per-request
// CFCacheStore resolved from the live request context.
//
// tagPurge uses the CREDENTIALS form with a fetch stub, so the e2e exercises
// the store's built-in zone purge client (endpoint, auth header, body shape)
// inside workerd while only RECORDING the purged Cache-Tags (same module-state
// pattern as error-log.ts) — workerd has no purge-by-tag, so the e2e asserts
// (a) the client sent the namespaced tags and (b) the surviving L1 entry keeps
// serving — purge mode's delegation contract.
import { getRequestContext } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
} from "@rangojs/router/cache";
import type { AppBindings } from "./env.js";

export const purgeLog: string[][] = [];

export function clearPurgeLog(): void {
  purgeLog.length = 0;
}

const perRequest = new WeakMap<object, CFCacheStore>();

function resolveStore(): CFCacheStore {
  const ctx = getRequestContext<AppBindings>();
  let store = perRequest.get(ctx);
  if (!store) {
    store = new CFCacheStore({
      namespace: "purge-e2e",
      defaults: { ttl: 60, swr: 300 },
      ctx: ctx.executionContext!,
      kv: ctx.env.KV,
      tagPurge: {
        zoneId: "e2e-zone",
        apiToken: "e2e-token",
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { tags: string[] };
          purgeLog.push(body.tags);
          return Response.json({ success: true });
        }) as typeof fetch,
      },
    });
    perRequest.set(ctx, store);
  }
  return store;
}

// Delegate the RESPONSE tier too: path.json routes cache through
// getResponse/putResponse (the document family), and the cache layer silently
// skips caching when a store omits an optional family — a wrapper implementing
// only the segment tier looks like "never caches" for response routes.
export const purgeModeStore: SegmentCacheStore = {
  get: (key: string): Promise<CacheGetResult | null> => resolveStore().get(key),
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
