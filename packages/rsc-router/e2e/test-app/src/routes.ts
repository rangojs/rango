import { route } from "rsc-router";

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
});
