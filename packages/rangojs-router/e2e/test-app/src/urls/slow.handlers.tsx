import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { SlowLoader } from "../loaders.js";
import { RevalidateButton } from "../components/RevalidateButton.js";
import {
  SlowStreamingContent,
  SlowSkipSsrContent,
} from "../components/SlowStreamingContent.js";

export const SlowHandler: Handler<"slow"> = async (ctx) => {
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
};

export const SlowStreamingHandler: Handler<"slowStreaming"> = () => (
  <SlowStreamingContent loader={SlowLoader} />
);

export const SlowStreamingSkipSsrHandler: Handler<"slowStreamingSkipSsr"> = () => (
  <SlowSkipSsrContent loader={SlowLoader} />
);
