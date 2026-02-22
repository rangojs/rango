import { urls } from "@rangojs/router";

/**
 * Response cache test routes URL patterns.
 * Each route is wrapped in cache() to test response caching for various MIME types.
 *
 * Every handler embeds Date.now() in the response body. Cached responses will
 * have the exact same timestamp on subsequent requests. Non-cached responses
 * will always have a different (newer) timestamp.
 */
export const responseCachePatterns = urls(({ path, cache }) => [
  // Cached routes: wrapped in cache() boundary
  cache({ ttl: 600 }, () => [
    path.json("/cached-json", () => {
      return { source: "cached-json", ts: Date.now() };
    }, { name: "responseCache.json" }),

    path.text("/cached-text", () => {
      return `text:${Date.now()}`;
    }, { name: "responseCache.text" }),

    path.xml("/cached-xml", () => {
      return `<root><ts>${Date.now()}</ts></root>`;
    }, { name: "responseCache.xml" }),

    path.html("/cached-html", () => {
      return `<h1 data-ts="${Date.now()}">cached</h1>`;
    }, { name: "responseCache.html" }),

    path.md("/cached-md", () => {
      return `# ts:${Date.now()}`;
    }, { name: "responseCache.md" }),
  ]),

  // Control route: NOT wrapped in cache() — handler always re-executes
  path.json("/uncached-json", () => {
    return { source: "uncached-json", ts: Date.now() };
  }, { name: "responseCache.uncached" }),
]);
