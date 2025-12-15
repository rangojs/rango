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
  // Routes for testing route resolution and trailing slashes
  blog: {
    index: "/blog",
    post: "/blog/:postId",
  },
});
