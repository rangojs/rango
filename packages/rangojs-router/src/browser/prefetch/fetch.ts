/**
 * Prefetch Fetch
 *
 * Fetch-based prefetch logic used by Link (hover/viewport/render strategies)
 * and useRouter().prefetch(). Sends source-independent requests (no
 * _rsc_segments, no X-RSC-Router-Client-Path) so the server returns all
 * matched segments. The Response is stored in an in-memory cache for
 * instant consumption on subsequent navigation.
 */

import {
  buildCacheKey,
  hasPrefetch,
  markPrefetchInflight,
  storePrefetch,
  clearPrefetchInflight,
  currentGeneration,
} from "./cache.js";
import { getRangoState } from "../rango-state.js";
import { enqueuePrefetch } from "./queue.js";
import { shouldPrefetch } from "./policy.js";

/**
 * Build an RSC partial URL for prefetching plus the clean path for headers.
 * Does NOT include _rsc_segments — the server will render all matched
 * segments, making the response source-independent.
 * Includes _rsc_v for version mismatch detection when available.
 * Returns null for malformed or cross-origin URLs.
 */
function buildPrefetchUrl(
  url: string,
  version?: string,
): { fetchUrl: URL; cleanPath: string } | null {
  let targetUrl: URL;
  try {
    targetUrl = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (targetUrl.origin !== window.location.origin) {
    return null;
  }
  // Capture clean path before adding RSC params
  const cleanPath = targetUrl.pathname + targetUrl.search;
  targetUrl.searchParams.set("_rsc_partial", "true");
  if (version) {
    targetUrl.searchParams.set("_rsc_v", version);
  }
  return { fetchUrl: targetUrl, cleanPath };
}

/**
 * Core prefetch fetch logic. Fetches the response, fully buffers the body,
 * and stores it in the in-memory cache. Returns a Promise and accepts an
 * optional AbortSignal for cancellation by the prefetch queue.
 */
function executePrefetchFetch(
  key: string,
  targetUrl: URL,
  cleanPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const gen = currentGeneration();
  markPrefetchInflight(key);

  return fetch(targetUrl, {
    priority: "low" as RequestPriority,
    signal,
    headers: {
      "X-Rango-State": getRangoState(),
      // Send clean target path (without _rsc_* params) as
      // X-RSC-Router-Client-Path so the server sees isSameRouteNavigation=true
      // and skips intercept routing.
      "X-RSC-Router-Client-Path": cleanPath,
      "X-Rango-Prefetch": "1",
    },
  })
    .then(async (response) => {
      if (!response.ok) return;
      // Fully buffer the response body so the cached Response is
      // self-contained and doesn't depend on the network connection.
      const buffer = await response.arrayBuffer();
      const cachedResponse = new Response(buffer, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      storePrefetch(key, cachedResponse, gen);
    })
    .catch(() => {
      // Silently ignore prefetch failures (including abort)
    })
    .finally(() => {
      clearPrefetchInflight(key);
    });
}

/**
 * Prefetch (direct): fetch with low priority and store in in-memory cache.
 * Used by hover strategy -- fires immediately without queueing.
 *
 * The segmentIds parameter is accepted for API compatibility but not sent
 * to the server — prefetch always requests all matched segments.
 */
export function prefetchDirect(
  url: string,
  _segmentIds: string[],
  version?: string,
): void {
  if (!shouldPrefetch()) return;

  const result = buildPrefetchUrl(url, version);
  if (!result) return;
  const key = buildCacheKey(url);
  if (hasPrefetch(key)) return;
  executePrefetchFetch(key, result.fetchUrl, result.cleanPath);
}

/**
 * Prefetch (queued): goes through the concurrency-limited queue.
 * Used by viewport/render strategies to avoid flooding the server.
 * Returns the cache key for use in cleanup.
 *
 * The segmentIds parameter is accepted for API compatibility but not sent
 * to the server — prefetch always requests all matched segments.
 */
export function prefetchQueued(
  url: string,
  _segmentIds: string[],
  version?: string,
): string {
  if (!shouldPrefetch()) return "";
  const result = buildPrefetchUrl(url, version);
  if (!result) return "";
  const key = buildCacheKey(url);
  if (hasPrefetch(key)) return key;
  enqueuePrefetch(key, (signal) =>
    executePrefetchFetch(key, result.fetchUrl, result.cleanPath, signal),
  );
  return key;
}
