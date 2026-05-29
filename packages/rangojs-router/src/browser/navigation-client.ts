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
  isBrowserDebugEnabled,
  startBrowserTransaction,
} from "./logging.js";
import { getRangoState } from "./rango-state.js";
import {
  extractRscHeaderUrl,
  emptyResponse,
  handleReloadHeader,
  teeWithCompletion,
} from "./response-adapter.js";
import {
  buildPrefetchKey,
  buildSourceKey,
  consumeInflightPrefetch,
  consumePrefetch,
} from "./prefetch/cache.js";

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
  deps: Pick<RscBrowserDependencies, "createFromFetch">,
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

      // Check completed in-memory prefetch cache before making a network
      // request. Try the source-scoped key first (populated when the server
      // tagged the prefetch response as source-sensitive, e.g. intercepts,
      // or when a Link opted in with `prefetchKey=":source"`), then fall
      // back to the wildcard slot shared across source pages.
      // Both keys embed the Rango state, so state rotation (deploy or
      // server-action invalidation) auto-invalidates both scopes.
      // Skip cache for stale revalidation (needs fresh data), HMR (needs
      // fresh modules), and intercept contexts (source-dependent responses).
      const canUsePrefetch = !staleRevalidation && !hmr && !interceptSourceUrl;
      const rangoState = getRangoState();
      const wildcardKey = buildPrefetchKey(rangoState, fetchUrl);
      const cacheKey = buildSourceKey(rangoState, previousUrl, fetchUrl);

      let cachedResponse: Response | null = null;
      let hitKey: string | null = null;
      if (canUsePrefetch) {
        cachedResponse = consumePrefetch(cacheKey);
        if (cachedResponse) {
          hitKey = cacheKey;
        } else {
          cachedResponse = consumePrefetch(wildcardKey);
          if (cachedResponse) hitKey = wildcardKey;
        }
      }

      let inflightResponsePromise: Promise<Response | null> | null = null;
      if (canUsePrefetch && !cachedResponse) {
        inflightResponsePromise = consumeInflightPrefetch(cacheKey);
        if (inflightResponsePromise) {
          hitKey = cacheKey;
        } else {
          inflightResponsePromise = consumeInflightPrefetch(wildcardKey);
          if (inflightResponsePromise) hitKey = wildcardKey;
        }
      }
      // Track when the stream completes
      let resolveStreamComplete: () => void;
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve;
      });

      /**
       * Validate RSC control headers on any response (fresh, cached, or
       * in-flight). Handles version-mismatch reloads and server redirects.
       * Returns the response unchanged when no control header is present.
       */
      const validateRscHeaders = (
        response: Response,
        source: string,
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

        return response;
      };

      /** Start a fresh navigation fetch (no cache / inflight hit). */
      const doFreshFetch = (): Promise<Response> => {
        if (tx) {
          browserDebugLog(tx, "fetching", {
            path: `${fetchUrl.pathname}${fetchUrl.search}`,
          });
        }

        return fetch(fetchUrl, {
          headers: {
            "X-RSC-Router-Client-Path": previousUrl,
            "X-Rango-State": getRangoState(),
            ...(tx && { "X-RSC-Router-Request-Id": tx.requestId }),
            ...(interceptSourceUrl && {
              "X-RSC-Router-Intercept-Source": interceptSourceUrl,
            }),
            ...(hmr && { "X-RSC-HMR": "1" }),
          },
          signal,
        }).then((response) => {
          const validated = validateRscHeaders(response, "fetch");
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
      };

      let responsePromise: Promise<Response>;

      if (cachedResponse) {
        if (tx) {
          browserDebugLog(tx, "prefetch cache hit", {
            key: hitKey,
            wildcard: hitKey === wildcardKey,
          });
        }
        responsePromise = Promise.resolve(cachedResponse).then((response) => {
          const validated = validateRscHeaders(response, "prefetch cache");
          if (validated instanceof Promise) return validated;

          return teeWithCompletion(
            validated,
            () => {
              if (tx) browserDebugLog(tx, "stream complete (from cache)");
              resolveStreamComplete();
            },
            signal,
          );
        });
      } else if (inflightResponsePromise) {
        if (tx) {
          browserDebugLog(tx, "reusing inflight prefetch", {
            key: hitKey,
            wildcard: hitKey === wildcardKey,
          });
        }
        const adoptedViaWildcard = hitKey === wildcardKey;
        responsePromise = inflightResponsePromise.then(async (response) => {
          if (!response) {
            if (tx) {
              browserDebugLog(tx, "inflight prefetch unavailable, refetching");
            }
            return doFreshFetch();
          }

          // Cross-source safety: an inflight promise adopted via the
          // wildcard key may turn out to be source-scoped (server emitted
          // `X-RSC-Prefetch-Scope: source`), which means it was built for
          // a different source page. Discard and refetch.
          if (
            adoptedViaWildcard &&
            response.headers.get("x-rsc-prefetch-scope") === "source"
          ) {
            if (tx) {
              browserDebugLog(
                tx,
                "wildcard inflight turned out source-scoped, refetching",
              );
            }
            return doFreshFetch();
          }

          const validated = validateRscHeaders(response, "inflight prefetch");
          if (validated instanceof Promise) return validated;

          return teeWithCompletion(
            validated,
            () => {
              if (tx) {
                browserDebugLog(tx, "stream complete (from inflight prefetch)");
              }
              resolveStreamComplete();
            },
            signal,
          );
        });
      } else {
        responsePromise = doFreshFetch();
      }

      try {
        const payload = await deps.createFromFetch<RscPayload>(responsePromise);

        if (tx) {
          browserDebugLog(tx, "response received", {
            isPartial: payload.metadata?.isPartial,
            matchedCount: payload.metadata?.matched?.length ?? 0,
            diffCount: payload.metadata?.diff?.length ?? 0,
          });
        }
        return { payload, streamComplete };
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
