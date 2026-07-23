import type {
  NavigationClient,
  FetchPartialOptions,
  FetchPartialResult,
  RscPayload,
  RscBrowserDependencies,
} from "./types.js";
import { NetworkError, ServerRedirect, isNetworkError } from "../errors.js";
import {
  browserDebugLog,
  debugLog,
  isBrowserDebugEnabled,
  startBrowserTransaction,
} from "./logging.js";
import { getRangoState } from "./rango-state.js";
import { isActionFenceActive } from "./action-fence.js";
import {
  expandPayloadFragments,
  SEGMENT_FRAGMENT_CAPABILITY_HEADER,
  SEGMENT_FRAGMENT_RECOVERY_HEADER,
  SegmentFragmentDecodeError,
} from "../segment-fragments.js";
import {
  extractRscHeaderUrl,
  emptyResponse,
  handleReloadHeader,
  teeWithCompletion,
  isForeignRouterId,
} from "./response-adapter.js";
import {
  buildPrefetchKey,
  buildSourceKey,
  consumeInflightPrefetch,
  consumePrefetch,
  disableFragmentPassthrough,
  isFragmentPassthroughEnabled,
  type DecodedPrefetch,
} from "./prefetch/cache.js";
import { cancelAllPrefetches } from "./prefetch/loader.js";

/**
 * Create a navigation client for fetching RSC payloads
 *
 * The client handles building URLs with RSC parameters and
 * deserializing the response using the RSC runtime.
 *
 * Checks the in-memory prefetch cache before making a network request.
 * Tries the source-scoped key first (populated when the server tagged
 * the response as source-sensitive via `X-RSC-Prefetch-Scope: source`)
 * and falls back to the Rango-state-keyed wildcard slot used for the
 * common source-agnostic case.
 *
 * @param deps - RSC browser dependencies (createFromFetch)
 * @returns NavigationClient instance
 */
export function createNavigationClient(
  deps: Pick<
    RscBrowserDependencies,
    "createFromFetch" | "createFromReadableStream"
  >,
): NavigationClient {
  return {
    /**
     * Fetch a partial RSC payload for navigation
     *
     * First checks the in-memory prefetch cache for a matching entry.
     * If found, uses the cached response instantly. Otherwise sends
     * current segment IDs to the server for diff-based rendering.
     *
     * @param options - Fetch options
     * @returns RSC payload with segments and metadata, plus stream completion promise
     */
    async fetchPartial(
      options: FetchPartialOptions,
    ): Promise<FetchPartialResult> {
      const {
        targetUrl,
        segmentIds,
        previousUrl,
        signal,
        staleRevalidation,
        interceptSourceUrl,
        version,
        routerId,
        hmr,
      } = options;

      const debugEnabled = isBrowserDebugEnabled();
      const tx = debugEnabled
        ? startBrowserTransaction(staleRevalidation ? "revalidate" : "navigate")
        : null;
      if (tx) {
        browserDebugLog(tx, "request start", {
          from: previousUrl,
          to: targetUrl,
          segments: segmentIds,
          staleRevalidation: !!staleRevalidation,
        });
      }

      // Build fetch URL with partial rendering params (used for both
      // cache key lookup and actual fetch if cache misses)
      const fetchUrl = new URL(targetUrl, window.location.origin);
      fetchUrl.searchParams.set("_rsc_partial", "true");
      fetchUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
      if (staleRevalidation) {
        fetchUrl.searchParams.set("_rsc_stale", "true");
      }
      if (version) {
        fetchUrl.searchParams.set("_rsc_v", version);
      }
      if (routerId) {
        fetchUrl.searchParams.set("_rsc_rid", routerId);
      }

      // If the lazy prefetch runtime has not loaded yet, prevent a deferred
      // speculative request from starting after this navigation misses the
      // synchronous cache lookup and begins its own fetch.
      cancelAllPrefetches(targetUrl);

      // Check completed in-memory prefetch cache before making a network
      // request. Try the source-scoped key first (populated when the server
      // tagged the prefetch response as source-sensitive, e.g. intercepts,
      // or when a Link opted in with `prefetchKey=":source"`), then fall
      // back to the wildcard slot shared across source pages.
      // Both keys embed the Rango state, so state rotation (deploy or
      // server-action invalidation) auto-invalidates both scopes.
      // Skip cache for stale revalidation (needs fresh data), HMR (needs
      // fresh modules), and intercept contexts (source-dependent responses).
      // Suspend prefetch consumption while an action is in flight: a queued
      // prefetch holds pre-mutation data and must not be served until the
      // action's response decides whether anything changed.
      const canUsePrefetch =
        !staleRevalidation &&
        !hmr &&
        !interceptSourceUrl &&
        !isActionFenceActive();
      const rangoState = getRangoState();
      const wildcardKey = buildPrefetchKey(rangoState, fetchUrl);
      const cacheKey = buildSourceKey(rangoState, previousUrl, fetchUrl);

      let cachedEntry: DecodedPrefetch | null = null;
      let hitKey: string | null = null;
      if (canUsePrefetch) {
        cachedEntry = consumePrefetch(cacheKey);
        if (cachedEntry) {
          hitKey = cacheKey;
        } else {
          cachedEntry = consumePrefetch(wildcardKey);
          if (cachedEntry) hitKey = wildcardKey;
        }
      }

      let inflightEntryPromise: Promise<DecodedPrefetch | null> | null = null;
      if (canUsePrefetch && !cachedEntry) {
        inflightEntryPromise = consumeInflightPrefetch(cacheKey);
        if (inflightEntryPromise) {
          hitKey = cacheKey;
        } else {
          inflightEntryPromise = consumeInflightPrefetch(wildcardKey);
          if (inflightEntryPromise) hitKey = wildcardKey;
        }
      }
      /**
       * Validate RSC control headers on any response (fresh, cached, or
       * in-flight). Handles version-mismatch reloads and server redirects.
       * Returns the response unchanged when no control header is present.
       */
      const validateRscHeaders = (
        response: Response,
        source: string,
        resolveStreamComplete: () => void,
      ): Response | Promise<Response> => {
        // Version mismatch — server wants a full page reload
        const reloadResult = handleReloadHeader(response, {
          onBlocked: resolveStreamComplete,
          onReload: (url) => {
            if (tx) {
              browserDebugLog(tx, `version mismatch, reloading (${source})`, {
                reloadUrl: url,
              });
            }
          },
        });
        if (reloadResult) return reloadResult;

        // Server-side redirect without state: the server returned 204 with
        // X-RSC-Redirect instead of a 3xx (which fetch would auto-follow
        // to a URL rendering full HTML). Throw ServerRedirect so the
        // navigation bridge catches it and re-navigates with _skipCache.
        const redirect = extractRscHeaderUrl(response, "X-RSC-Redirect");
        if (redirect === "blocked") {
          resolveStreamComplete();
          return emptyResponse();
        }
        if (redirect) {
          if (tx) {
            browserDebugLog(tx, `server redirect (${source})`, {
              redirectUrl: redirect.url,
            });
          }
          resolveStreamComplete();
          throw new ServerRedirect(redirect.url, undefined);
        }

        // Integrity check (pre-decode): refuse a foreign app's content response
        // before createFromFetch imports its chunks. Ordered AFTER the reload
        // and redirect handlers — control responses are never stamped with
        // X-RSC-Router-Id, so they are steered first and never reach here.
        if (isForeignRouterId(response, routerId)) {
          if (tx) {
            browserDebugLog(tx, `router id mismatch, reloading (${source})`);
          }
          resolveStreamComplete();
          window.location.href = targetUrl;
          return new Promise<Response>(() => {});
        }

        return response;
      };

      /** Start and decode one fresh navigation fetch. */
      const freshResult = (
        fragmentPassthrough = isFragmentPassthroughEnabled(),
        fragmentRecovery = false,
      ): {
        payload: Promise<RscPayload>;
        streamComplete: Promise<void>;
      } => {
        let resolveStreamComplete!: () => void;
        const streamComplete = new Promise<void>((resolve) => {
          resolveStreamComplete = resolve;
        });

        if (tx) {
          browserDebugLog(tx, "fetching", {
            path: `${fetchUrl.pathname}${fetchUrl.search}`,
            fragmentPassthrough,
          });
        }

        const responsePromise = fetch(fetchUrl, {
          // During an action's flight the state is not rotated, so the old
          // X-Rango-State still matches the Vary-keyed HTTP-cache entry; bypass
          // it so a genuine mid-action navigation fetches fresh instead of being
          // served the stale prefetched bytes. Fragment recovery also bypasses
          // HTTP caches so it reaches the server's decode-and-evict path.
          ...((isActionFenceActive() || fragmentRecovery) && {
            cache: "no-store" as RequestCache,
          }),
          headers: {
            "X-RSC-Router-Client-Path": previousUrl,
            // Reuse the single per-operation read (see rangoState above): the
            // cache-key lookup and this header must agree on one value, and the
            // cookie read has side effects (external-rotation notify) we do not
            // want to fire twice per navigation.
            "X-Rango-State": rangoState,
            ...(fragmentPassthrough && {
              [SEGMENT_FRAGMENT_CAPABILITY_HEADER]: "1",
            }),
            ...(fragmentRecovery && {
              [SEGMENT_FRAGMENT_RECOVERY_HEADER]: "1",
            }),
            ...(tx && { "X-RSC-Router-Request-Id": tx.requestId }),
            ...(interceptSourceUrl && {
              "X-RSC-Router-Intercept-Source": interceptSourceUrl,
            }),
            ...(hmr && { "X-RSC-HMR": "1" }),
          },
          signal,
        }).then((response) => {
          const validated = validateRscHeaders(
            response,
            "fetch",
            resolveStreamComplete,
          );
          if (validated instanceof Promise) return validated;

          return teeWithCompletion(
            validated,
            () => {
              if (tx) browserDebugLog(tx, "stream complete");
              resolveStreamComplete();
            },
            signal,
          );
        });

        return {
          payload: deps.createFromFetch<RscPayload>(responsePromise),
          streamComplete,
        };
      };

      let payloadPromise: Promise<RscPayload>;
      let streamCompletePromise: Promise<void>;
      // True only for a prefetch-cache hit whose stream had already fully drained
      // (complete === true). A still-streaming hit and the fresh path stay false,
      // so only a fully-warmed prefetch commits in a transition (no fallback flash).
      let fullyPrefetched = false;

      if (cachedEntry) {
        if (tx) {
          browserDebugLog(tx, "prefetch cache hit (warm)", {
            key: hitKey,
            wildcard: hitKey === wildcardKey,
          });
        }
        payloadPromise = cachedEntry.payload;
        streamCompletePromise = cachedEntry.streamComplete;
        // Only a hit whose stream already fully drained is "fully prefetched";
        // a still-streaming hit must keep streaming its fallbacks like a cold load.
        fullyPrefetched = cachedEntry.complete;
      } else if (inflightEntryPromise) {
        if (tx) {
          browserDebugLog(tx, "reusing inflight prefetch", {
            key: hitKey,
            wildcard: hitKey === wildcardKey,
          });
        }
        const adoptedViaWildcard = hitKey === wildcardKey;
        const entry = await inflightEntryPromise;
        if (!entry) {
          if (tx) {
            browserDebugLog(tx, "inflight prefetch unavailable, refetching");
          }
          ({ payload: payloadPromise, streamComplete: streamCompletePromise } =
            freshResult());
        } else if (adoptedViaWildcard && entry.scope === "source") {
          // A wildcard-adopted inflight that turned out source-scoped was
          // built for a different source page. Discard and refetch.
          if (tx) {
            browserDebugLog(
              tx,
              "wildcard inflight turned out source-scoped, refetching",
            );
          }
          ({ payload: payloadPromise, streamComplete: streamCompletePromise } =
            freshResult());
        } else {
          payloadPromise = entry.payload;
          streamCompletePromise = entry.streamComplete;
          // Adopted inflight is normally still streaming (false), but read the
          // flag in case it completed between publish and adoption.
          fullyPrefetched = entry.complete;
        }
      } else {
        ({ payload: payloadPromise, streamComplete: streamCompletePromise } =
          freshResult());
      }

      try {
        // [VT-DIAG] Gated behind INTERNAL_RANGO_DEBUG. Times how long the RSC
        // payload ROOT takes to resolve: ~full-stream duration means the root
        // model is not flushed early (server/runtime buffering, e.g. wrangler
        // dev gzip); fast means the block, if any, is downstream in render.
        const vtDebugStart = isBrowserDebugEnabled() ? performance.now() : 0;
        let payload: RscPayload;
        try {
          payload = await payloadPromise;
          // Fragment envelopes (#700): expand replay-HIT envelopes before any
          // consumer renders — this await is the single point all three payload
          // sources (fresh fetch, warm prefetch, adopted inflight) flow through.
          await expandPayloadFragments(payload, deps.createFromReadableStream);
        } catch (error) {
          if (
            !(error instanceof SegmentFragmentDecodeError) ||
            signal?.aborted
          ) {
            throw error;
          }

          // A fragment-only failure means the outer payload was valid but one
          // stored segment was not. Retry once without the capability header:
          // the server then takes CacheScope's decode-and-evict path and renders
          // fresh. Never recurse; a failed recovery remains an ordinary
          // unprocessable navigation response.
          if (tx) browserDebugLog(tx, "fragment decode failed, retrying");
          disableFragmentPassthrough();
          const recovery = freshResult(false, true);
          streamCompletePromise = recovery.streamComplete;
          fullyPrefetched = false;
          payload = await recovery.payload;
          await expandPayloadFragments(payload, deps.createFromReadableStream);
        }
        if (isBrowserDebugEnabled()) {
          debugLog("[VT-DIAG] payloadResolved", {
            ms: Math.round(performance.now() - vtDebugStart),
            isPartial: payload.metadata?.isPartial,
          });
        }

        if (tx) {
          browserDebugLog(tx, "response received", {
            isPartial: payload.metadata?.isPartial,
            matchedCount: payload.metadata?.matched?.length ?? 0,
            diffCount: payload.metadata?.diff?.length ?? 0,
          });
        }
        return {
          payload,
          streamComplete: streamCompletePromise,
          fullyPrefetched,
        };
      } catch (error) {
        // Convert network-level errors to NetworkError for proper handling
        if (isNetworkError(error)) {
          throw new NetworkError(
            "Unable to connect to server. Please check your connection.",
            {
              cause: error,
              url: fetchUrl.toString(),
              operation: staleRevalidation ? "revalidation" : "navigation",
            },
          );
        }
        throw error;
      }
    },
  };
}
