import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { SlowLoader } from "../loaders.js";
import { RevalidateButton } from "../components/RevalidateButton.js";

/**
 * Slow routes URL patterns - for testing loader behavior
 * Routes: slow, slowStreaming, slowStreamingSkipSsr
 *
 * Note: slowProduct.detail is defined in urls.tsx inline because
 * it has an intercept that needs to share the same parent context.
 */
export const slowPatternsWithoutDetail = urls(({ path, loader, loading }) => [
  // Slow route WITHOUT loading - loader should be awaited (blocking)
  path(
    "/slow",
    async (ctx) => {
      const { message, count, loadedAt } = await ctx.use(SlowLoader);
      return (
        <div data-testid="slow-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="slow-title">Slow Route (No Loading)</h1>
          <p data-testid="slow-message">{message}</p>
          <p data-testid="slow-count">Load count: {count}</p>
          <p data-testid="slow-loaded-at">Loaded: {loadedAt}</p>
          <div data-testid="slow-actions">
            <RevalidateButton testId="slow-revalidate-btn" />
          </div>
        </div>
      );
    },
    { name: "slow" },
    () => [loader(SlowLoader)]
  ),

  // Slow route WITH loading - loader should stream (non-blocking)
  path(
    "/slow-streaming",
    async (ctx) => {
      const { message, count, loadedAt } = await ctx.use(SlowLoader);
      return (
        <div data-testid="slow-streaming-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="slow-streaming-title">
            Slow Route (With Loading)
          </h1>
          <p data-testid="slow-streaming-message">{message}</p>
          <p data-testid="slow-streaming-count">Load count: {count}</p>
          <p data-testid="slow-streaming-loaded-at">Loaded: {loadedAt}</p>
          <div data-testid="slow-streaming-actions">
            <RevalidateButton testId="slow-streaming-revalidate-btn" />
          </div>
        </div>
      );
    },
    { name: "slowStreaming" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="slow-streaming-loading">
          <p>Loading slow data...</p>
        </div>
      ),
    ]
  ),

  // Slow route WITH loading skipSSR - awaited on SSR, streams on navigation
  path(
    "/slow-streaming-skip-ssr",
    async (ctx) => {
      const { message, count, loadedAt } = await ctx.use(SlowLoader);
      return (
        <div data-testid="slow-skip-ssr-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="slow-skip-ssr-title">
            Slow Route (Skip SSR Loading)
          </h1>
          <p data-testid="slow-skip-ssr-message">{message}</p>
          <p data-testid="slow-skip-ssr-count">Load count: {count}</p>
          <p data-testid="slow-skip-ssr-loaded-at">Loaded: {loadedAt}</p>
          <div data-testid="slow-skip-ssr-actions">
            <RevalidateButton testId="slow-skip-ssr-revalidate-btn" />
          </div>
        </div>
      );
    },
    { name: "slowStreamingSkipSsr" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="slow-skip-ssr-loading">
          <p>Loading slow data...</p>
        </div>,
        { ssr: false }
      ),
    ]
  ),
]);

// Keep original export for backwards compatibility if needed
export const slowPatterns = slowPatternsWithoutDetail;
