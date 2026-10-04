// Issue #973 fixture store: a CFCacheStore whose KV tag-marker writes land
// SLOW_MARKER_PUT_MS late, the way a KV put can on a deployed worker. Local
// workerd KV lands the put before the same request reads the marker again,
// which hid the bug: a server action that ran revalidateTag() and then
// re-rendered read entries tagged with it until the put landed. Only the
// /ryow-action route caches on it (cache({ store: slowMarkerStore })).
//
// Once that route renders, the store sits in the handler's explicit-store
// registry for the life of the isolate, and every updateTag()/revalidateTag()
// in the app reaches it. So invalidateTags forwards only the fixture's own
// tags (RYOW_TAG_PREFIX): any other invalidation would otherwise wait
// SLOW_MARKER_PUT_MS on a marker nobody reads, and the app-level store and
// every other suite keep real KV timing.
//
// Same module-singleton shape as purge-store.ts: CFCacheStore needs the
// request's ExecutionContext, so each call delegates to a per-request store.
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
import { RYOW_TAG_PREFIX } from "./loaders/ryow.js";

/** How long a tag-marker put is held before it reaches KV. */
const SLOW_MARKER_PUT_MS = 3000;

/** CFCacheStore's KV key prefix for tag markers (TAG_MARKER_PREFIX). */
const TAG_MARKER_KEY = "__tag__/";

function withSlowMarkerPuts(kv: KVNamespace): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "put" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (key: string, ...rest: unknown[]) => {
        if (key.includes(TAG_MARKER_KEY)) {
          await new Promise((resolve) =>
            setTimeout(resolve, SLOW_MARKER_PUT_MS),
          );
        }
        return value.call(target, key, ...rest);
      };
    },
  });
}

const perRequest = new WeakMap<object, CFCacheStore>();

function resolveStore(): CFCacheStore {
  const ctx = getRequestContext<AppBindings>();
  let store = perRequest.get(ctx);
  if (!store) {
    store = new CFCacheStore({
      namespace: "slow-marker-e2e",
      // Its own KV key space: revalidateTag() also reaches the app-level
      // store, whose marker for the same tag lands at once under the build
      // version's keys and would hide the held one.
      version: "slow-marker-e2e",
      ctx: ctx.executionContext!,
      kv: withSlowMarkerPuts(ctx.env.KV),
    });
    perRequest.set(ctx, store);
  }
  return store;
}

export const slowMarkerStore: SegmentCacheStore = {
  get: (key: string): Promise<CacheGetResult | null | CacheReadError> =>
    resolveStore().get(key),
  set: (
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> => resolveStore().set(key, data, ttl, swr),
  delete: (key: string): Promise<boolean> => resolveStore().delete(key),
  getItem: (key: string): Promise<CacheItemResult | null> =>
    resolveStore().getItem(key),
  setItem: (
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> => resolveStore().setItem(key, value, options),
  invalidateTags: (tags: string[]): Promise<void> => {
    const own = tags.filter((tag) => tag.startsWith(RYOW_TAG_PREFIX));
    return own.length > 0
      ? resolveStore().invalidateTags(own)
      : Promise.resolve();
  },
};
