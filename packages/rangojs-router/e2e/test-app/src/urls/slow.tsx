import { urls } from "@rangojs/router";
import { SlowLoader } from "../loaders.js";
import {
  SlowHandler,
  SlowStreamingHandler,
  SlowStreamingSkipSsrHandler,
} from "./slow.handlers.js";

/**
 * Slow routes URL patterns - for testing loader behavior
 * Routes: slow, slowStreaming, slowStreamingSkipSsr
 *
 * Note: slowProduct.detail is defined in urls.tsx inline because
 * it has an intercept that needs to share the same parent context.
 */
export const slowPatternsWithoutDetail = urls(({ path, loader, loading }) => [
  path("/slow", SlowHandler, { name: "slow" }, () => [loader(SlowLoader)]),

  path(
    "/slow-streaming",
    SlowStreamingHandler,
    { name: "slowStreaming" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="slow-streaming-loading">
          <p>Loading slow data...</p>
        </div>,
      ),
    ],
  ),

  path(
    "/slow-streaming-skip-ssr",
    SlowStreamingSkipSsrHandler,
    { name: "slowStreamingSkipSsr" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="slow-skip-ssr-loading">
          <p>Loading slow data...</p>
        </div>,
        { ssr: false },
      ),
    ],
  ),
]);

// Keep original export for backwards compatibility if needed
export const slowPatterns = slowPatternsWithoutDetail;
