/**
 * Prefetch Fetch
 *
 * Fetch-based prefetch logic used by Link (hover/viewport/render strategies)
 * and useRouter().prefetch(). Sends the same headers and segment IDs as a
 * real navigation so the server returns a proper diff. The Response is fully
 * buffered and stored in an in-memory cache for instant consumption on
 * subsequent navigation.
 *
 * In-flight promises are tracked in the cache so that navigation can reuse
 * a prefetch that is still downloading instead of starting a duplicate request.
 */

import {
  buildPrefetchKey,
  buildSourceKey,
  hasPrefetch,
  markPrefetchInflight,
  setInflightPromiseWithAliases,
  storePrefetch,
  clearPrefetchInflight,
  currentGeneration,
} from "./cache.js";
import { getRangoState } from "../rango-state.js";
import { enqueuePrefetch } from "./queue.js";
import { shouldPrefetch } from "./policy.js";
import { debugLog } from "../logging.js";

/**
 * Check if a URL resolves to the current page (same pathname + search).
 * Used to prevent same-page prefetching, which produces a trivial diff
 * that would corrupt the (default wildcard) prefetch cache entry.
 */
function isSamePage(url: string): boolean {
  try {
    const target = new URL(url, window.location.origin);
    return (
      target.pathname + target.search ===
      window.location.pathname + window.location.search
    );
  } catch {
    return false;
  }
}

/**
 * Build an RSC partial URL for prefetching.
 * Includes _rsc_segments so the server can diff against currently mounted
 * segments, and _rsc_v for version mismatch detection.
 * Returns null for malformed or cross-origin URLs.
 */
function buildPrefetchUrl(
  url: string,
  segmentIds: string[],
  version?: string,
  routerId?: string,
): URL | null {
  let targetUrl: URL;
  try {
    targetUrl = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (targetUrl.origin !== window.location.origin) {
    return null;
  }
  targetUrl.searchParams.set("_rsc_partial", "true");
  if (segmentIds.length > 0) {
    targetUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
  }
  if (version) {
    targetUrl.searchParams.set("_rsc_v", version);
  }
  if (routerId) {
    targetUrl.searchParams.set("_rsc_rid", routerId);
  }
  return targetUrl;
}

/**
 * Core prefetch fetch logic. Fetches the response, tees the body, and stores
 * one branch in the in-memory cache. The returned Promise resolves to the
 * sibling navigation branch (or null on failure) so navigation can safely
 * reuse an in-flight prefetch via consumeInflightPrefetch().
 *
 * Inflight + storage key selection:
 *
 * - `forceSourceScope` (Link opted in with `prefetchKey=":source"`): single
 *   inflight registration under `sourceKey`; response stored under
 *   `sourceKey`. No wildcard leak is possible.
 *
 * - Otherwise: dual inflight registration under both `wildcardKey` and
 *   `sourceKey` so same-source navigations adopt directly via their own
 *   source key. Storage key is chosen at response time from the
 *   `X-RSC-Prefetch-Scope` header — `"source"` → `sourceKey` (intercept
 *   modals etc.), anything else → `wildcardKey`. Cross-source navigations
 *   that adopted via `wildcardKey` must bail out in `navigation-client.ts`
 *   if the adopted response turns out to be source-scoped.
 */
function executePrefetchFetch(
  wildcardKey: string,
  sourceKey: string,
  fetchUrl: string,
  forceSourceScope: boolean,
  signal?: AbortSignal,
): Promise<Response | null> {
  const gen = currentGeneration();
  const inflightKeys = forceSourceScope
    ? [sourceKey]
    : [wildcardKey, sourceKey];
  for (const k of inflightKeys) markPrefetchInflight(k);

  const promise: Promise<Response | null> = fetch(fetchUrl, {
    priority: "low" as RequestPriority,
    signal,
    headers: {
      "X-Rango-State": getRangoState(),
      "X-RSC-Router-Client-Path": window.location.href,
      "X-Rango-Prefetch": "1",
    },
  })
    .then((response) => {
      if (!response.ok) return null;
      // Don't buffer with arrayBuffer() — that blocks until the entire
      // body downloads, defeating streaming for slow loaders.
      // Tee the body: one branch for navigation, one for cache storage.
      const [navStream, cacheStream] = response.body!.tee();
      const responseInit = {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      };
      let storageKey: string;
      if (forceSourceScope) {
        storageKey = sourceKey;
      } else {
        const scope = response.headers.get("x-rsc-prefetch-scope");
        storageKey = scope === "source" ? sourceKey : wildcardKey;
      }
      storePrefetch(storageKey, new Response(cacheStream, responseInit), gen);
      return new Response(navStream, responseInit);
    })
    .catch(() => null)
    .finally(() => {
      clearPrefetchInflight(inflightKeys[0]!);
    });

  setInflightPromiseWithAliases(inflightKeys, promise);
  return promise;
}

/**
 * Dedup check for prefetch entry presence.
 *
 * Forced `:source` must NOT dedupe against a pre-existing wildcard entry —
 * otherwise the source slot would stay unpopulated and navigation from
 * this source would fall through to the (potentially wrong) wildcard
 * response, defeating the opt-out.
 */
function hasPrefetchHit(
  forceSourceScope: boolean,
  wildcardKey: string,
  sourceKey: string,
): boolean {
  return forceSourceScope
    ? hasPrefetch(sourceKey)
    : hasPrefetch(wildcardKey) || hasPrefetch(sourceKey);
}

/**
 * Prefetch (direct): fetch with low priority and store in in-memory cache.
 * Used by hover strategy -- fires immediately without queueing.
 *
 * By default the wildcard key (Rango-state-keyed) is used for inflight
 * dedup and for responses that are not source-sensitive; source-scoped
 * storage is automatic when the server emits `X-RSC-Prefetch-Scope: source`.
 *
 * Pass `prefetchKey=":source"` to force source-scoped inflight + storage
 * (e.g. when the target uses a custom `revalidate()` that reads
 * `currentUrl` and the wildcard slot would serve the wrong diff).
 */
export function prefetchDirect(
  url: string,
  segmentIds: string[],
  version?: string,
  routerId?: string,
  prefetchKey?: ":source",
): void {
  if (!shouldPrefetch()) return;

  const targetUrl = buildPrefetchUrl(url, segmentIds, version, routerId);
  if (!targetUrl) return;
  const forceSourceScope = prefetchKey === ":source";
  // Skip same-page prefetch — a same-page diff is trivial and would corrupt
  // the wildcard cache entry used for cross-page navigation.
  // When `:source` is forced the entry is source-scoped (single-aliased to
  // itself), so it cannot poison any shared slot — allow it.
  if (!forceSourceScope && isSamePage(url)) {
    return;
  }
  const sourceHref = window.location.href;
  const rangoState = getRangoState();
  const wildcardKey = buildPrefetchKey(rangoState, targetUrl);
  const sourceKey = buildSourceKey(rangoState, sourceHref, targetUrl);
  if (hasPrefetchHit(forceSourceScope, wildcardKey, sourceKey)) {
    debugLog("[prefetch] direct dedup (key already exists)", {
      url,
      wildcardKey,
      sourceKey,
      forceSourceScope,
    });
    return;
  }
  debugLog("[prefetch] direct fetch", {
    url,
    wildcardKey,
    sourceKey,
    source: sourceHref,
    forceSourceScope,
  });
  executePrefetchFetch(
    wildcardKey,
    sourceKey,
    targetUrl.toString(),
    forceSourceScope,
  );
}

/**
 * Prefetch (queued): goes through the concurrency-limited queue.
 * Used by viewport/render strategies to avoid flooding the server.
 * Returns the inflight key (wildcard by default, source-scoped when
 * `prefetchKey=":source"` is passed).
 */
export function prefetchQueued(
  url: string,
  segmentIds: string[],
  version?: string,
  routerId?: string,
  prefetchKey?: ":source",
): string {
  if (!shouldPrefetch()) return "";
  const targetUrl = buildPrefetchUrl(url, segmentIds, version, routerId);
  if (!targetUrl) return "";
  const forceSourceScope = prefetchKey === ":source";
  if (!forceSourceScope && isSamePage(url)) {
    return "";
  }
  const sourceHref = window.location.href;
  const rangoState = getRangoState();
  const wildcardKey = buildPrefetchKey(rangoState, targetUrl);
  const sourceKey = buildSourceKey(rangoState, sourceHref, targetUrl);
  const queueKey = forceSourceScope ? sourceKey : wildcardKey;
  if (hasPrefetchHit(forceSourceScope, wildcardKey, sourceKey)) {
    debugLog("[prefetch] queued dedup (key already exists)", {
      url,
      wildcardKey,
      sourceKey,
      forceSourceScope,
    });
    return queueKey;
  }
  const fetchUrlStr = targetUrl.toString();
  enqueuePrefetch(queueKey, (signal) => {
    // Re-check at execution time: a hover-triggered prefetchDirect may
    // have started or completed this key while the item sat in the queue.
    if (hasPrefetchHit(forceSourceScope, wildcardKey, sourceKey)) {
      return Promise.resolve();
    }
    if (!forceSourceScope && isSamePage(url)) {
      return Promise.resolve();
    }
    return executePrefetchFetch(
      wildcardKey,
      sourceKey,
      fetchUrlStr,
      forceSourceScope,
      signal,
    ).then(() => {});
  });
  return queueKey;
}
