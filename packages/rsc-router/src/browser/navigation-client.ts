import type {
  NavigationClient,
  FetchPartialOptions,
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
     * @returns RSC payload with segments and metadata
     */
    async fetchPartial(options: FetchPartialOptions): Promise<RscPayload> {
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

      // Fetch with previous URL header
      const responsePromise = fetch(fetchUrl, {
        headers: {
          "X-RSC-Router-Client-Path": previousUrl,
        },
        signal,
      });

      // Deserialize RSC payload
      const payload = await deps.createFromFetch<RscPayload>(responsePromise);

      return payload;
    },
  };
}
