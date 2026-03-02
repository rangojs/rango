import { getRequestContext, urls } from "@rangojs/router";

/**
 * Response cache test routes URL patterns.
 * Each route is wrapped in cache() to test response caching for various MIME types.
 *
 * Every handler embeds Date.now() in the response body. Cached responses will
 * have the exact same timestamp on subsequent requests. Non-cached responses
 * will always have a different (newer) timestamp.
 */
export const responseCachePatterns = urls(({ path, cache, middleware }) => [
  // Cached routes: wrapped in cache() boundary
  cache({ ttl: 600 }, () => [
    path.json(
      "/cached-json",
      () => {
        return { source: "cached-json", ts: Date.now() };
      },
      { name: "responseCache.json" },
    ),

    path.text(
      "/cached-text",
      () => {
        return `text:${Date.now()}`;
      },
      { name: "responseCache.text" },
    ),

    path.xml(
      "/cached-xml",
      () => {
        return `<root><ts>${Date.now()}</ts></root>`;
      },
      { name: "responseCache.xml" },
    ),

    path.html(
      "/cached-html",
      () => {
        return `<h1 data-ts="${Date.now()}">cached</h1>`;
      },
      { name: "responseCache.html" },
    ),

    path.md(
      "/cached-md",
      () => {
        return `# ts:${Date.now()}`;
      },
      { name: "responseCache.md" },
    ),

    path.json(
      "/cached-json-query",
      (ctx) => {
        return {
          source: "cached-json-query",
          q: ctx.url.searchParams.get("q") ?? "",
          ts: Date.now(),
        };
      },
      { name: "responseCache.jsonQuery" },
    ),
  ]),

  // Control route: NOT wrapped in cache() — handler always re-executes
  path.json(
    "/uncached-json",
    () => {
      return { source: "uncached-json", ts: Date.now() };
    },
    { name: "responseCache.uncached" },
  ),

  // Callback test routes (under /cb-test/ so the app-level middleware matches).
  // The app-level middleware registers a pre-handler onResponse callback that
  // sets X-Pre-Handler-Ts with a fresh timestamp on every serve.
  cache({ ttl: 600 }, () => [
    // Route with route-level middleware that registers an onResponse callback.
    // This callback is applied by createResponseWithMergedHeaders during
    // handler execution, so it is baked into the cached response.
    path.json(
      "/cb-test/with-route-cb",
      () => {
        return { source: "route-cb", ts: Date.now() };
      },
      { name: "responseCache.routeCb" },
      () => [
        middleware(async (_ctx, next) => {
          const reqCtx = getRequestContext();
          reqCtx?.onResponse((response) => {
            const headers = new Headers(response.headers);
            headers.set("X-Route-Callback-Ts", String(Date.now()));
            return new Response(response.body, {
              status: response.status,
              headers,
            });
          });
          await next();
        }),
      ],
    ),
  ]),
]);
