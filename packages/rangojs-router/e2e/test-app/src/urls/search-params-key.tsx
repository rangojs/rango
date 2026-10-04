import { urls } from "@rangojs/router";

/**
 * Fixtures for the global `cache.searchParams` key filter (router.tsx sets
 * `searchParams: { exclude: ["utm_*", "x_e2e_excluded"] }`).
 *
 * Dedicated routes (not /response-cache/*) so the filter tests never share a
 * cache slot with other suites: an excluded-only URL collapses onto the BARE
 * path key, which would collide with any other test hitting the same path.
 *
 * Every handler embeds Date.now(): identical timestamps across requests prove
 * a cache HIT (shared slot), differing timestamps prove distinct slots.
 */
export const searchParamsKeyPatterns = urls(({ path, cache }) => [
  cache({ ttl: 600 }, () => [
    path.json(
      "/cached",
      (ctx) => ({
        source: "spk-cached",
        // The handler must still see the full query string (the filter is
        // cache-key-only) -- on a MISS this bakes the live value in.
        utm: ctx.url.searchParams.get("utm_source") ?? "",
        page: ctx.url.searchParams.get("page") ?? "",
        ts: Date.now(),
      }),
      { name: "spk.cached" },
    ),
  ]),
]);
