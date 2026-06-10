/**
 * Prefetch Fetch
 *
 * Fetch-based prefetch logic used by Link (hover/viewport/render strategies)
 * and useRouter().prefetch(). Sends the same headers and segment IDs as a
 * real navigation so the server returns a proper diff. The response is fetched
 * AND eagerly decoded (createFromFetch) up front: decoding the Flight stream
 * resolves the route's client references, so the route's JS chunks are imported
 * during prefetch rather than on click. The decoded payload is stored in an
 * in-memory cache and reused verbatim by navigation, so a prefetched click
 * loads no new code.
 *
 * In-flight promises are tracked in the cache so that navigation can reuse
 * a prefetch that is still downloading/decoding instead of starting a
 * duplicate request.
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
  type DecodedPrefetch,
} from "./cache.js";
import { getRangoState } from "../rango-state.js";
import { enqueuePrefetch } from "./queue.js";
import { shouldPrefetch } from "./policy.js";
import { debugLog } from "../logging.js";
import { teeWithCompletion, isForeignRouterId } from "../response-adapter.js";
import type { RscPayload } from "../types.js";

/**
 * Decoder injected at app startup (see setPrefetchDecoder). This is
 * `deps.createFromFetch` — decoupled from the RSC runtime exactly like the
 * navigation client. Prefetch decodes through it so the route's client chunks
 * are pulled during the prefetch, not on click.
 */
type PrefetchDecoder = (response: Promise<Response>) => Promise<RscPayload>;

let decoder: PrefetchDecoder | null = null;

/**
 * Wire the RSC decoder used to eagerly decode prefetched responses. Called
 * once from initBrowserApp with the same createFromFetch the navigation client
 * uses. Until set, prefetch warming is inert (prefetches are skipped) — the
 * browser app always sets it before any Link can fire.
 */
export function setPrefetchDecoder(fn: PrefetchDecoder): void {
  decoder = fn;
}

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
 * Core prefetch fetch logic. Fetches the response, eagerly decodes it, and
 * stores the decoded payload in the in-memory cache. The returned Promise
 * resolves to the decoded entry (or null on failure / control header) so
 * navigation can safely reuse an in-flight prefetch via
 * consumeInflightPrefetch().
 *
 * Eager decode is the warming step: createFromFetch parses the Flight stream,
 * which resolves the route's client references and imports its JS chunks. The
 * stored payload is reused as-is by navigation, so the click loads no new code.
 *
 * Control headers are NOT acted on here. A speculative prefetch must never
 * reload the page or throw a redirect — if the response carries X-RSC-Reload
 * or X-RSC-Redirect, we drop it (resolve null) and let the real navigation
 * re-fetch and honor it.
 *
 * Inflight + storage key selection:
 *
 * - `forceSourceScope` (Link opted in with `prefetchKey=":source"`): single
 *   inflight registration under `sourceKey`; entry stored under `sourceKey`.
 *   No wildcard leak is possible.
 *
 * - Otherwise: dual inflight registration under both `wildcardKey` and
 *   `sourceKey` so same-source navigations adopt directly via their own
 *   source key. Storage key is chosen at response time from the
 *   `X-RSC-Prefetch-Scope` header — `"source"` → `sourceKey` (intercept
 *   modals etc.), anything else → `wildcardKey`. The entry records its scope
 *   so cross-source navigations that adopted via `wildcardKey` can bail out
 *   in `navigation-client.ts` when the adopted entry turns out source-scoped.
 */
function executePrefetchFetch(
  wildcardKey: string,
  sourceKey: string,
  fetchUrl: string,
  forceSourceScope: boolean,
  expectedRouterId?: string,
  signal?: AbortSignal,
): Promise<DecodedPrefetch | null> {
  const gen = currentGeneration();
  const inflightKeys = forceSourceScope
    ? [sourceKey]
    : [wildcardKey, sourceKey];
  for (const k of inflightKeys) markPrefetchInflight(k);

  const promise: Promise<DecodedPrefetch | null> = fetch(fetchUrl, {
    priority: "low" as RequestPriority,
    signal,
    headers: {
      "X-Rango-State": getRangoState(),
      "X-RSC-Router-Client-Path": window.location.href,
      "X-Rango-Prefetch": "1",
    },
  })
    .then((response) => {
      if (!response.ok || !decoder) return null;
      // Control headers mean this response is stale (reload) or redirecting.
      // Don't warm it — drop so navigation re-fetches and acts on the header.
      if (
        response.headers.has("X-RSC-Reload") ||
        response.headers.has("X-RSC-Redirect")
      ) {
        return null;
      }
      // Integrity check: never warm (or decode/import the chunks of) a foreign
      // app's payload. A speculative prefetch must never reload — just drop it;
      // navigation re-fetches and the server steers it.
      if (isForeignRouterId(response, expectedRouterId)) {
        return null;
      }

      const scope: "source" | "wildcard" =
        forceSourceScope ||
        response.headers.get("x-rsc-prefetch-scope") === "source"
          ? "source"
          : "wildcard";
      const storageKey = scope === "source" ? sourceKey : wildcardKey;

      // Track stream completion off a tee so navigation's scroll/revalidation
      // gating matches the fresh-fetch path; decode the other branch.
      let resolveStreamComplete!: () => void;
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve;
      });
      const tracked = teeWithCompletion(
        response,
        () => resolveStreamComplete(),
        signal,
        // Speculative prefetch: a never-consumed/aborted stream error is benign.
        true,
      );

      // Eager decode: parsing the Flight stream imports the route's client
      // chunks now, not on click.
      const payload = decoder(Promise.resolve(tracked));
      // Mark handled so an unconsumed prefetch decode error stays quiet; the
      // error is still surfaced to navigation if it consumes the entry.
      payload.catch(() => {});

      const entry: DecodedPrefetch = { payload, streamComplete, scope };
      storePrefetch(storageKey, entry, gen);
      return entry;
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
    routerId,
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
      routerId,
      signal,
    ).then(() => {});
  });
  return queueKey;
}
