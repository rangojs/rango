"use client";

import { useLoader } from "@rangojs/router/client";
import { Link } from "@rangojs/router/client";
import { SlowLoader } from "../loaders.js";
import { RevalidateButton } from "./RevalidateButton.js";

/**
 * Client component for slow-streaming route content.
 * Uses useLoader() to get loader data, allowing the loading skeleton
 * to show immediately while this component suspends waiting for data.
 */
export function SlowStreamingContent() {
  const {
    data: { message, count, loadedAt },
  } = useLoader(SlowLoader);
  return (
    <div data-testid="slow-streaming-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="slow-streaming-title">Slow Route (With Loading)</h1>
      <p data-testid="slow-streaming-message">{message}</p>
      <p data-testid="slow-streaming-count">Load count: {count}</p>
      <p data-testid="slow-streaming-loaded-at">Loaded: {loadedAt}</p>
      <div data-testid="slow-streaming-actions">
        <RevalidateButton testId="slow-streaming-revalidate-btn" />
      </div>
    </div>
  );
}

/**
 * Client component for slow-streaming-skip-ssr route content.
 */
export function SlowSkipSsrContent() {
  const {
    data: { message, count, loadedAt },
  } = useLoader(SlowLoader);
  return (
    <div data-testid="slow-skip-ssr-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="slow-skip-ssr-title">Slow Route (Skip SSR Loading)</h1>
      <p data-testid="slow-skip-ssr-message">{message}</p>
      <p data-testid="slow-skip-ssr-count">Load count: {count}</p>
      <p data-testid="slow-skip-ssr-loaded-at">Loaded: {loadedAt}</p>
      <div data-testid="slow-skip-ssr-actions">
        <RevalidateButton testId="slow-skip-ssr-revalidate-btn" />
      </div>
    </div>
  );
}
