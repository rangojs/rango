import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
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
export const slowPatternsWithoutDetail = urls(({ path, layout, loader, loading }) => [
  path(
    "/slow",
    SlowHandler,
    { name: "slow" },
    () => [loader(SlowLoader)],
  ),

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
  // Layout-level loading: simulates putting loading() on the root layout.
  // The entire page content streams behind the skeleton on SSR.
  layout(
    () => (
      <div data-testid="layout-loading-shell"><Outlet /></div>
    ),
    () => [
      loading(
        <div data-testid="layout-loading-skeleton">
          <p>Loading page...</p>
        </div>,
      ),
      path(
        "/layout-loading",
        async () => {
          await new Promise((r) => setTimeout(r, 2000));
          return (
            <div data-testid="layout-loading-content">
              <p data-testid="layout-loading-text">Content loaded!</p>
            </div>
          );
        },
        { name: "layoutLoading" },
      ),
    ],
  ),
]);

// Keep original export for backwards compatibility if needed
export const slowPatterns = slowPatternsWithoutDetail;
