import type {
  NavigationClient,
  FetchPartialOptions,
  FetchPartialResult,
  RscPayload,
  RscBrowserDependencies,
} from "./types.js";
import { NetworkError, isNetworkError } from "../errors.js";

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
  options?: { prerenderPaths?: string[] },
): NavigationClient {
  const prerenderPaths = options?.prerenderPaths;

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

      console.log(`\n[Browser] >>> NAVIGATION`);
      console.log(`[Browser] From: ${previousUrl}`);
      console.log(`[Browser] To: ${targetUrl}`);
      console.log(`[Browser] Segments to send: ${segmentIds.join(", ")}`);
      if (staleRevalidation) {
        console.log(`[Browser] Stale revalidation request`);
      }

      // For pre-rendered routes, fetch the static .rsc file directly.
      // Skip for stale revalidation (needs live server data) and HMR.
      if (prerenderPaths?.length && !staleRevalidation && !hmr) {
        const targetPath = new URL(targetUrl, window.location.origin).pathname;
        const normalized = targetPath === "/" ? "/" : targetPath.replace(/\/$/, "");
        if (prerenderPaths.includes(normalized)) {
          const rscPath = normalized === "/"
            ? "/index.rsc"
            : `${normalized}/index.rsc`;
          const rscUrl = new URL(rscPath, window.location.origin);

          console.log(`[Browser] Fetching pre-rendered RSC: ${rscUrl.pathname}`);

          let resolveStreamComplete: () => void;
          const streamComplete = new Promise<void>((resolve) => {
            resolveStreamComplete = resolve;
          });

          const responsePromise = fetch(rscUrl, { signal }).then((response) => {
            if (!response.ok) {
              throw new Error("prerender-fallback");
            }
            if (!response.body) {
              resolveStreamComplete();
              return response;
            }
            const [rscStream, trackingStream] = response.body.tee();
            (async () => {
              const reader = trackingStream.getReader();
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
                resolveStreamComplete();
              }
            })();
            return new Response(rscStream, {
              headers: response.headers,
              status: response.status,
              statusText: response.statusText,
            });
          });

          try {
            const payload = await deps.createFromFetch<RscPayload>(responsePromise);
            return { payload, streamComplete };
          } catch (error) {
            if (error instanceof Error && error.message === "prerender-fallback") {
              console.log(`[Browser] Static .rsc not found, falling back to partial fetch`);
            } else {
              throw error;
            }
          }
        }
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

      console.log(`[Browser] Fetching: ${fetchUrl.pathname}${fetchUrl.search}`);

      // Track when the stream completes
      let resolveStreamComplete: () => void;
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve;
      });

      // Create a response promise that tracks stream completion
      const responsePromise = fetch(fetchUrl, {
        headers: {
          "X-RSC-Router-Client-Path": previousUrl,
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
          console.log(`[Browser] Version mismatch - reloading: ${reloadUrl}`);
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
            console.log("[STREAMING] RSC stream complete");
            resolveStreamComplete();
          }
        })();

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
