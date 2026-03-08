/**
 * Prefetch Fetch
 *
 * Fetch-based prefetch logic used by Link (hover/viewport/render strategies)
 * and useRouter().prefetch(). Sends low-priority fetch requests with
 * X-Rango-State and X-Rango-Prefetch headers so the browser HTTP cache
 * can serve the response on subsequent navigation.
 */

import {
  hasPrefetch,
  markPrefetchInflight,
  markPrefetched,
  clearPrefetchInflight,
  currentGeneration,
} from "./cache.js";
import { getRangoState } from "../rango-state.js";
import { enqueuePrefetch } from "./queue.js";
import { shouldPrefetch } from "./policy.js";

/**
 * Build an RSC partial URL for prefetching.
 * Includes _rsc_v for version mismatch detection when available.
 * Returns null for malformed or cross-origin URLs to prevent
 * leaking router headers to external origins.
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
 * Build the dedup key for prefetch tracking.
 * Includes the source page pathname so the same target prefetched from
 * different pages gets separate entries — the server response varies on
 * X-RSC-Router-Client-Path (source page context).
 */
function buildPrefetchKey(targetUrl: URL): string {
  return window.location.href + "\0" + targetUrl.pathname + targetUrl.search;
}

/**
 * Core prefetch fetch logic. Returns a Promise and accepts an optional
 * AbortSignal for cancellation by the prefetch queue.
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
    .then((response) => {
      // Drain body to ensure full download for browser HTTP cache.
      // pipeTo avoids decoding the stream into a JS string (unlike .text()).
      if (response.ok && response.body) {
        return response.body
          .pipeTo(new WritableStream())
          .then(() => markPrefetched(key, gen));
      }
    })
    .catch(() => {
      // Silently ignore prefetch failures (including abort)
    })
    .finally(() => {
      clearPrefetchInflight(key);
    });
}

/**
 * Prefetch (direct): fetch with low priority and store in browser HTTP cache.
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
  const key = buildPrefetchKey(targetUrl);
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
  const key = buildPrefetchKey(targetUrl);
  if (hasPrefetch(key)) return key;
  const fetchUrlStr = targetUrl.toString();
  enqueuePrefetch(key, (signal) =>
    executePrefetchFetch(key, fetchUrlStr, signal),
  );
  return key;
}
