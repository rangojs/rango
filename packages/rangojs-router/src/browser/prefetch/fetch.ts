/**
 * Prefetch Fetch
 *
 * Fetch-based prefetch logic used by Link (hover/viewport/render strategies)
 * and useRouter().prefetch(). Sends the same headers and segment IDs as a
 * real navigation so the server returns a proper diff. The Response is fully
 * buffered and stored in an in-memory cache for instant consumption on
 * subsequent navigation.
 */

import {
  buildPrefetchKey,
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
 * Build an RSC partial URL for prefetching.
 * Includes _rsc_segments so the server can diff against currently mounted
 * segments, and _rsc_v for version mismatch detection.
 * Returns null for malformed or cross-origin URLs.
 */
function buildPrefetchUrl(
  url: string,
  segmentIds: string[],
  version?: string,
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
  return targetUrl;
}

/**
 * Core prefetch fetch logic. Fetches the response, fully buffers the body,
 * and stores it in the in-memory cache. Returns a Promise and accepts an
 * optional AbortSignal for cancellation by the prefetch queue.
 */
function executePrefetchFetch(
  key: string,
  fetchUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const gen = currentGeneration();
  markPrefetchInflight(key);

  return fetch(fetchUrl, {
    priority: "low" as RequestPriority,
    signal,
    headers: {
      "X-Rango-State": getRangoState(),
      "X-RSC-Router-Client-Path": window.location.href,
      "X-Rango-Prefetch": "1",
    },
  })
    .then(async (response) => {
      if (!response.ok) return;
      // Fully buffer the response body so the cached Response is
      // self-contained and doesn't depend on the network connection.
      // This eliminates the race condition where the user clicks before
      // the response body has been fully downloaded.
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
 */
export function prefetchDirect(
  url: string,
  segmentIds: string[],
  version?: string,
): void {
  if (!shouldPrefetch()) return;

  const targetUrl = buildPrefetchUrl(url, segmentIds, version);
  if (!targetUrl) return;
  const key = buildPrefetchKey(window.location.href, targetUrl);
  if (hasPrefetch(key)) return;
  executePrefetchFetch(key, targetUrl.toString());
}

/**
 * Prefetch (queued): goes through the concurrency-limited queue.
 * Used by viewport/render strategies to avoid flooding the server.
 * Returns the cache key for use in cleanup.
 */
export function prefetchQueued(
  url: string,
  segmentIds: string[],
  version?: string,
): string {
  if (!shouldPrefetch()) return "";
  const targetUrl = buildPrefetchUrl(url, segmentIds, version);
  if (!targetUrl) return "";
  const key = buildPrefetchKey(window.location.href, targetUrl);
  if (hasPrefetch(key)) return key;
  const fetchUrlStr = targetUrl.toString();
  enqueuePrefetch(key, (signal) =>
    executePrefetchFetch(key, fetchUrlStr, signal),
  );
  return key;
}
