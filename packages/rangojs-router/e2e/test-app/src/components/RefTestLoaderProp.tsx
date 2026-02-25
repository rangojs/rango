"use client";

import { useLoader, Link } from "@rangojs/router/client";
import type { SlowLoader } from "../loaders.js";
import { RevalidateButton } from "./RevalidateButton.js";

/**
 * Client component that receives a loader as a prop (passed from server component).
 * Tests that loader refs survive RSC serialization via toJSON.
 *
 * Uses `typeof SlowLoader` for the prop type -- this infers the full generic
 * from the loader definition, so the data type is automatically type-checked.
 */
export function RefTestLoaderProp({ loader }: { loader: typeof SlowLoader }) {
  const {
    data: { message, count, loadedAt },
  } = useLoader(loader);
  return (
    <div data-testid="ref-test-loader-page">
      <Link to="/" data-testid="back-link">
        &larr; Back to Home
      </Link>
      <h1 data-testid="ref-test-loader-title">Loader Ref as Prop</h1>
      <p data-testid="ref-test-loader-message">{message}</p>
      <p data-testid="ref-test-loader-count">Load count: {count}</p>
      <p data-testid="ref-test-loader-loaded-at">Loaded: {loadedAt}</p>
      <div data-testid="ref-test-loader-actions">
        <RevalidateButton testId="ref-test-loader-revalidate-btn" />
      </div>
    </div>
  );
}
