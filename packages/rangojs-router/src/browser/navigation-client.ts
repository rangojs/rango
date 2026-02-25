import type {
  NavigationClient,
  FetchPartialOptions,
  FetchPartialResult,
  RscPayload,
  RscBrowserDependencies,
} from "./types.js";
import { NetworkError, isNetworkError } from "../errors.js";
import {
  browserDebugLog,
  isBrowserDebugEnabled,
  startBrowserTransaction,
} from "./logging.js";

/**
 * Create a navigation client for fetching RSC payloads
 *
 * The client handles building URLs with RSC parameters and
 * deserializing the response using the RSC runtime.
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
     * Sends current segment IDs to the server so it can determine
     * which segments need to be re-rendered (diff).
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

      // Track when the stream completes
      let resolveStreamComplete: () => void;
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve;
      });

      // Create a response promise that tracks stream completion
      const responsePromise = fetch(fetchUrl, {
        headers: {
          "X-RSC-Router-Client-Path": previousUrl,
          ...(tx && { "X-RSC-Router-Request-Id": tx.requestId }),
          ...(interceptSourceUrl && {
            "X-RSC-Router-Intercept-Source": interceptSourceUrl,
          }),
          ...(hmr && { "X-RSC-HMR": "1" }),
        },
        signal,
      }).then((response) => {
        // Check for version mismatch - server wants us to reload
        const reloadUrl = response.headers.get("X-RSC-Reload");
        if (reloadUrl) {
          if (tx) {
            browserDebugLog(tx, "version mismatch, reloading", { reloadUrl });
          }
          window.location.href = reloadUrl;
          // Return a never-resolving promise to prevent further processing
          return new Promise<Response>(() => {});
        }

        if (!response.body) {
          // No body means stream is already complete
          resolveStreamComplete();
          return response;
        }

        // Tee the stream: one for RSC runtime, one for tracking completion
        const [rscStream, trackingStream] = response.body.tee();

        // Consume the tracking stream to detect when it closes
        (async () => {
          const reader = trackingStream.getReader();

          // Cancel tracking if navigation is aborted
          const onAbort = reader.cancel.bind(reader);
          signal?.addEventListener("abort", onAbort, { once: true });

          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
            reader.releaseLock();
            if (tx) {
              browserDebugLog(tx, "stream complete");
            }
            resolveStreamComplete();
          }
        })().catch((error) => {
          console.error("[Browser] Error reading tracking stream:", error);
          resolveStreamComplete();
        });

        // Return response with the RSC stream
        return new Response(rscStream, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      });

      try {
        // Deserialize RSC payload
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
