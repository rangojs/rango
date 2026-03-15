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
  teeWithCompletion,
} from "./response-adapter.js";
import { buildCacheKey, consumePrefetch } from "./prefetch/cache.js";

/**
 * Create a navigation client for fetching RSC payloads
 *
 * The client handles building URLs with RSC parameters and
 * deserializing the response using the RSC runtime.
 *
 * Checks the in-memory prefetch cache before making a network request.
 * Prefetch responses are source-independent (contain all matched segments),
 * so they can serve navigation from any source page.
 *
 * @param deps - RSC browser dependencies (createFromFetch)
 * @returns NavigationClient instance
 *
 * @example
 * ```typescript
 * import { createFromFetch } from "@vitejs/plugin-rsc/browser";
 *
 * const client = createNavigationClient({ createFromFetch });
 *
 * const payload = await client.fetchPartial({
 *   targetUrl: "/shop/products",
 *   segmentIds: ["root", "shop"],
 *   previousUrl: "/",
 * });
 * ```
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

      // Check in-memory prefetch cache before making a network request.
      // Skip cache for:
      // - stale revalidation (needs fresh data from server)
      // - HMR (needs fresh modules)
      // - intercept contexts (source-dependent responses)
      const cacheKey = buildCacheKey(targetUrl);
      const cachedResponse =
        !staleRevalidation && !hmr && !interceptSourceUrl
          ? consumePrefetch(cacheKey)
          : null;

      // Track when the stream completes
      let resolveStreamComplete: () => void;
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve;
      });

      let responsePromise: Promise<Response>;

      if (cachedResponse) {
        if (tx) {
          browserDebugLog(tx, "prefetch cache hit", { key: cacheKey });
        }
        // Cached response body is already fully buffered (arrayBuffer),
        // so stream completion is immediate.
        responsePromise = Promise.resolve(cachedResponse).then((response) => {
          return teeWithCompletion(
            response,
            () => {
              if (tx) browserDebugLog(tx, "stream complete (from cache)");
              resolveStreamComplete();
            },
            signal,
          );
        });
      } else {
        // Build fetch URL with partial rendering params
        const fetchUrl = new URL(targetUrl, window.location.origin);
        fetchUrl.searchParams.set("_rsc_partial", "true");
        fetchUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
        if (staleRevalidation) {
          fetchUrl.searchParams.set("_rsc_stale", "true");
        }
        if (version) {
          fetchUrl.searchParams.set("_rsc_v", version);
        }
        if (tx) {
          browserDebugLog(tx, "fetching", {
            path: `${fetchUrl.pathname}${fetchUrl.search}`,
          });
        }

        responsePromise = fetch(fetchUrl, {
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
          // Check for version mismatch - server wants us to reload
          const reload = extractRscHeaderUrl(response, "X-RSC-Reload");
          if (reload === "blocked") {
            resolveStreamComplete();
            return emptyResponse();
          }
          if (reload) {
            if (tx) {
              browserDebugLog(tx, "version mismatch, reloading", {
                reloadUrl: reload.url,
              });
            }
            window.location.href = reload.url;
            return new Promise<Response>(() => {});
          }

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
              browserDebugLog(tx, "server redirect", {
                redirectUrl: redirect.url,
              });
            }
            resolveStreamComplete();
            throw new ServerRedirect(redirect.url, undefined);
          }

          return teeWithCompletion(
            response,
            () => {
              if (tx) browserDebugLog(tx, "stream complete");
              resolveStreamComplete();
            },
            signal,
          );
        });
      }

      try {
        // Deserialize RSC payload
        const payload = await deps.createFromFetch<RscPayload>(responsePromise);

        // Client-side diff: prefetch responses contain ALL matched segments,
        // but we only need to update segments the client doesn't already have.
        // Filter diff to exclude currently-mounted segment IDs so the
        // reconciler preserves existing segments (layouts, shared loaders)
        // and only applies new ones from the prefetch response.
        if (cachedResponse && payload.metadata?.diff) {
          const currentIds = new Set(segmentIds);
          payload.metadata.diff = payload.metadata.diff.filter(
            (id) => !currentIds.has(id),
          );
        }

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
          // Build the URL that was actually fetched for diagnostic purposes
          const errorUrl = new URL(targetUrl, window.location.origin);
          errorUrl.searchParams.set("_rsc_partial", "true");
          throw new NetworkError(
            "Unable to connect to server. Please check your connection.",
            {
              cause: error,
              url: errorUrl.toString(),
              operation: staleRevalidation ? "revalidation" : "navigation",
            },
          );
        }
        throw error;
      }
    },
  };
}
