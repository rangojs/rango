// ============================================================================
// Cloudflare zone purge-by-tag helper
// ============================================================================
//
// Ready-made `tagPurge` implementation for CFCacheStoreOptions: POSTs the
// Cache-Tags handed over by invalidateTags() to the zone purge endpoint.
// Kept transport-only (no store coupling) so it is unit-testable with an
// injected fetch and reusable for onRevalidateTag.

/**
 * Tags per purge_cache API call. Cloudflare's documented purge-by-tag batch
 * limit has historically been 30 tags per call (the newer all-plans limits
 * page quotes 100 operations per request); chunking at 30 stays under both.
 * @internal
 */
export const PURGE_TAGS_PER_CALL = 30;

export interface CloudflareZonePurgeOptions {
  /** Zone to purge (Cloudflare dashboard -> zone overview -> Zone ID). */
  zoneId: string;
  /** API token with the `Zone.Cache Purge` permission for that zone. */
  apiToken: string;
  /**
   * API origin override, mainly for tests/proxies.
   * Defaults to `https://api.cloudflare.com`.
   */
  apiBase?: string;
  /** fetch override, mainly for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Create a purge-by-tag function for {@link CFCacheStoreOptions.tagPurge} (or
 * `onRevalidateTag`). Chunks the tag list under the per-call API limit and
 * rejects on any non-success response, so a failed purge surfaces through
 * `updateTag()` instead of silently leaving L1 stale.
 *
 * Purge-by-tag is available on ALL Cloudflare plans (since April 2025), but
 * account-level purge rate limits apply (Free: 5 calls/min) — keep invalidation
 * tag batches small and low-frequency on lower plans.
 */
export function createCloudflareZonePurge(
  options: CloudflareZonePurgeOptions,
): (cacheTags: string[]) => Promise<void> {
  const { zoneId, apiToken } = options;
  // Fail at construction, not at the first updateTag(): a store wired with an
  // unset env var would otherwise report the misconfig only when the first
  // invalidation rejects — long after deploy.
  if (typeof zoneId !== "string" || zoneId.length === 0) {
    throw new Error(
      "[createCloudflareZonePurge] zoneId is required (Cloudflare dashboard " +
        "-> zone overview -> Zone ID). Check the env var/secret it is read from.",
    );
  }
  if (typeof apiToken !== "string" || apiToken.length === 0) {
    throw new Error(
      "[createCloudflareZonePurge] apiToken is required (an API token with " +
        "the Zone.Cache Purge permission for the zone). Check the secret it " +
        "is read from.",
    );
  }
  const apiBase = options.apiBase ?? "https://api.cloudflare.com";
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = `${apiBase}/client/v4/zones/${zoneId}/purge_cache`;

  return async (cacheTags: string[]): Promise<void> => {
    for (let i = 0; i < cacheTags.length; i += PURGE_TAGS_PER_CALL) {
      const chunk = cacheTags.slice(i, i + PURGE_TAGS_PER_CALL);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: chunk }),
      });
      // The API reports failures both via HTTP status and a success flag.
      // Require an EXPLICIT success: true — an empty body, an HTML error
      // page, invalid JSON, or `{}` on a 2xx is NOT a confirmed purge, and
      // purge mode trusts surviving L1 entries on the strength of this call,
      // so an unconfirmed purge must reject rather than pass silently.
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        errors?: { code?: number; message?: string }[];
      } | null;
      if (!response.ok || body?.success !== true) {
        const detail =
          body?.errors
            ?.map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
            .join("; ") ??
          (response.ok
            ? `HTTP ${response.status} with a missing/invalid success body`
            : `HTTP ${response.status}`);
        throw new Error(
          `[createCloudflareZonePurge] purge_cache failed for ${chunk.length} ` +
            `tag(s): ${detail}`,
        );
      }
    }
  };
}
