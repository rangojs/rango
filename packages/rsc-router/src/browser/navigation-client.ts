import type {
  NavigationClient,
  FetchPartialOptions,
  FetchPartialResult,
  RscPayload,
  RscBrowserDependencies,
} from "./types.js";

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
  deps: Pick<RscBrowserDependencies, "createFromFetch">
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
      options: FetchPartialOptions
    ): Promise<FetchPartialResult> {
      const { targetUrl, segmentIds, previousUrl, signal } = options;

      console.log(`\n[Browser] >>> NAVIGATION`);
      console.log(`[Browser] From: ${previousUrl}`);
      console.log(`[Browser] To: ${targetUrl}`);
      console.log(`[Browser] Segments to send: ${segmentIds.join(", ")}`);

      // Build fetch URL with partial rendering params
      const fetchUrl = new URL(targetUrl);
      fetchUrl.searchParams.set("_rsc_partial", "true");
      fetchUrl.searchParams.set("_rsc_segments", segmentIds.join(","));

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
        },
        signal,
      }).then((response) => {
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
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } finally {
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

      // Deserialize RSC payload
      const payload = await deps.createFromFetch<RscPayload>(responsePromise);

      return { payload, streamComplete };
    },
  };
}
