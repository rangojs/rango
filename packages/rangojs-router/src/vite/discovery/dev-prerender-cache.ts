/**
 * Dev prerender result cache — memoizes /__rsc_prerender responses between
 * HMR edits (issue #654).
 *
 * Freshness invariant (why identity keying is correct): the endpoint
 * re-imports the user's entry module through a Vite module runner on every
 * request. When ANY module in the entry → router → urls → handler chain was
 * invalidated (file edit propagates up the importer graph), that import
 * re-executes the entry, `createRouter()` re-runs, and `RouterRegistry.set`
 * (router.ts) replaces the router instance with a NEW object. When nothing
 * was invalidated, the import is a module-cache hit and the instance is the
 * SAME object. Router-instance identity therefore IS the HMR generation:
 * keying the cache on it gives "serve cached until an edit invalidates the
 * chain" without any watcher bookkeeping, and the WeakMap lets every stale
 * generation's bucket be garbage-collected the moment the registry drops
 * the old instance.
 *
 * Staleness envelope: a cached body can only go stale through NON-module
 * inputs (a getParams() reading a database, fs content outside the module
 * graph). Production freezes those at build time, so serving them frozen
 * between edits makes dev MORE faithful to production, not less — the
 * pre-#654 behavior of re-rendering per request was the anomaly.
 */

import type { SerializedSegmentData } from "../../cache/types.js";

/** Structural slice of `matchForPrerender`'s result the payload derivation needs. */
export interface DevPrerenderMatchPayloadSource {
  segments: SerializedSegmentData[];
  handles: string;
  interceptSegments?: SerializedSegmentData[];
  interceptHandles?: string;
}

/** Serialized response bodies for the two endpoint variants of one render. */
export interface DevPrerenderPayloadBodies {
  /** `intercept != 1` response: the route's own segments + handles. */
  main: string;
  /**
   * `intercept=1` response: main + intercept segments with the MERGED handle
   * string. Falls back to `main` byte-for-byte when the route has no
   * intercept segments — mirroring the endpoint's historical behavior.
   */
  intercept: string;
}

export interface DevPrerenderCache {
  get(router: object, key: string): string | undefined;
  set(router: object, key: string, body: string): void;
}

/**
 * Derive both variant bodies from one matchForPrerender result, so a single
 * render warms the main AND intercept cache keys (matchForPrerender computes
 * intercept segments unconditionally either way — see prerender-match.ts
 * step 14).
 */
export function payloadBodiesFromResult(
  result: DevPrerenderMatchPayloadSource,
): DevPrerenderPayloadBodies {
  const main = JSON.stringify({
    segments: result.segments,
    handles: result.handles,
  });
  const intercept = result.interceptSegments?.length
    ? JSON.stringify({
        segments: [...result.segments, ...result.interceptSegments],
        handles: result.interceptHandles ?? "",
      })
    : main;
  return { main, intercept };
}

/**
 * Cache key for one endpoint request shape. `pathname` and `routeName` come
 * straight from the query; `passthrough` selects the getParams-checked match
 * path; `intercept` selects which variant body is served. All four dimensions
 * change the response, so all four are in the key.
 */
export function devPrerenderCacheKey(
  pathname: string,
  opts: { intercept: boolean; passthrough: boolean; routeName: string | null },
): string {
  return `${pathname}|i=${opts.intercept ? 1 : 0}|p=${opts.passthrough ? 1 : 0}|r=${opts.routeName ?? ""}`;
}

/**
 * Per-router FIFO cap: a dev session that visits an unbounded set of
 * prerendered pathnames (e.g. crawling param routes) must not grow one
 * bucket without limit. 500 rendered payloads is far beyond any interactive
 * session; eviction order does not matter for correctness (a miss just
 * re-renders).
 */
const MAX_ENTRIES_PER_ROUTER = 500;

export function createDevPrerenderCache(
  maxEntriesPerRouter: number = MAX_ENTRIES_PER_ROUTER,
): DevPrerenderCache {
  const buckets = new WeakMap<object, Map<string, string>>();
  return {
    get(router: object, key: string): string | undefined {
      return buckets.get(router)?.get(key);
    },
    set(router: object, key: string, body: string): void {
      let bucket = buckets.get(router);
      if (!bucket) {
        bucket = new Map();
        buckets.set(router, bucket);
      }
      if (!bucket.has(key) && bucket.size >= maxEntriesPerRouter) {
        const oldest = bucket.keys().next().value;
        if (oldest !== undefined) bucket.delete(oldest);
      }
      bucket.set(key, body);
    },
  };
}
