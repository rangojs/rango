import { route } from "rsc-router/browser";

/**
 * Test app routes definition
 */
export const testRoutes = route({
  index: "/",
  product: {
    detail: "/product/:productId",
  },
  // Routes for testing loader behavior with/without loading component
  slow: "/slow",
  slowStreaming: "/slow-streaming",
  slowStreamingSkipSsr: "/slow-streaming-skip-ssr",
});
