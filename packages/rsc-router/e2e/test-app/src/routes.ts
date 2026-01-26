import { route } from "@ivogt/rsc-router";

/**
 * Test app routes definition
 */
export const testRoutes = route({
  index: "/",
  product: {
    detail: "/product/:productId",
  },
  // Routes for testing trailing slash configuration
  trailingSlash: {
    // Explicit "ignore" - matches both /path and /path/, no redirect
    ignore: { path: "/ts-ignore", trailingSlash: "ignore" },
    // Explicit "always" - redirects /path to /path/
    always: { path: "/ts-always", trailingSlash: "always" },
    // Explicit "never" - redirects /path/ to /path
    never: { path: "/ts-never", trailingSlash: "never" },
  },
  // Routes for testing loader behavior with/without loading component
  slow: "/slow",
  slowStreaming: "/slow-streaming",
  slowStreamingSkipSsr: "/slow-streaming-skip-ssr",
  // Route for testing intercept with streaming loader
  slowProduct: {
    detail: "/slow-product/:productId",
  },
  // Routes for testing route resolution and trailing slashes
  blog: {
    index: "/blog",
    post: "/blog/:postId",
  },
  // Route for testing hydration error detection
  hydrationTest: "/hydration-test",
  // Routes for testing error boundary behavior
  errors: {
    index: "/errors",
    clientError: "/errors/client-error",
    serverError: "/errors/server-error",
    streamingError: "/errors/streaming-error",
  },
  // Route for testing handle passthrough to child RSC components
  handlePassthrough: "/handle-passthrough",
  // Route for testing async handle passthrough (meta set after delay)
  handlePassthroughAsync: "/handle-passthrough-async",
  // Routes for testing meta title templates
  metaTemplate: {
    index: "/meta-template",
    child: "/meta-template/child",
    absolute: "/meta-template/absolute",
    nested: "/meta-template/nested",
    nestedChild: "/meta-template/nested/child",
  },
  // Routes for testing meta unset functionality
  metaUnset: {
    index: "/meta-unset",
    child: "/meta-unset/child",
    unsetThenSet: "/meta-unset/unset-then-set",
  },
  // Routes for testing meta merging behavior
  metaMerge: {
    index: "/meta-merge",
    child: "/meta-merge/child",
    deep: "/meta-merge/deep/nested",
  },
  // Route for testing useFetchLoader hook (GET-based loader fetching)
  fetchLoader: "/fetch-loader",
  // Routes for testing useLoader and useFetchLoader hooks
  hookTests: {
    index: "/hook-tests",
    routeA: "/hook-tests/route-a",
    routeB: "/hook-tests/route-b",
    // Route WITHOUT loader registered - for testing useLoader throws
    noLoader: "/hook-tests/no-loader",
    // Route for testing form action
    formAction: "/hook-tests/form-action",
  },
  // Route for testing ctx.use(loader) composition
  loaderComposition: "/loader-composition",
  // Route for testing inline actions (defined directly in RSC, not imported)
  inlineAction: "/inline-action",
  // Routes for testing app-level middleware
  middlewareTest: {
    // Index page for middleware tests
    index: "/middleware-test",
    // Protected route - requires auth cookie
    protected: "/middleware-test/protected",
    protectedDashboard: "/middleware-test/protected/dashboard",
    // Error handling route - middleware catches errors
    errorHandler: "/middleware-test/error-handler/trigger",
    // Cookie test route - middleware sets/reads cookies
    cookies: "/middleware-test/cookies",
    // Params test route - middleware extracts :id param
    params: "/middleware-test/params/:paramId",
    // Shared variables test - middleware sets ctx.set(), handler reads
    sharedVars: "/middleware-test/shared-vars",
    // Route-level middleware test - middleware defined inside route()
    routeLevel: "/middleware-test/route-level",
    // Route-level middleware with params test - verify ctx.params is available in middleware
    routeLevelWithParams: "/middleware-test/route-level/:routeId",
  },
  // Route for testing progressive enhancement (no-JS form submissions)
  progressiveEnhancement: "/progressive-enhancement",
  // Routes for testing cache behavior
  cacheTest: {
    // Route with non-cached loader (default)
    nonCachedLoader: "/cache-test/non-cached-loader",
    // Route with cached loader (opt-in)
    cachedLoader: "/cache-test/cached-loader",
    // Index for intercept testing (links to detail)
    interceptIndex: "/cache-test/intercept",
    // Detail route for intercept testing (can be intercepted)
    interceptDetail: "/cache-test/intercept/:itemId",
    // Index for useLoader intercept testing
    useLoaderIndex: "/cache-test/useloader",
    // Detail route for useLoader intercept testing (non-cached)
    useLoaderDetail: "/cache-test/useloader/:itemId",
  },
  // Routes for testing proactive caching (cached layout with multiple routes)
  proactiveCache: {
    index: "/proactive-cache",
    itemA: "/proactive-cache/item-a",
    itemB: "/proactive-cache/item-b",
  },
  // Routes for testing cache status behavior (only cache 200 responses)
  cacheStatus: {
    success: "/cache-status/success",
    notFound: "/cache-status/not-found",
    serverError: "/cache-status/server-error",
    redirect: "/cache-status/redirect",
    redirectTarget: "/cache-status/redirect-target",
  },
});
