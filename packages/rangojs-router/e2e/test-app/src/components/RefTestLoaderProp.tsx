"use client";

import { useLoader } from "@rangojs/router/client";
import { Link } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { RevalidateButton } from "./RevalidateButton.js";

type SlowLoaderData = {
  message: string;
  count: number;
  loadedAt: string;
};

/**
 * Client component that receives a loader as a prop (passed from server component).
 * Tests that loader refs survive RSC serialization via toJSON.
 */
export function RefTestLoaderProp({
  loader,
}: {
  loader: LoaderDefinition<SlowLoaderData>;
}) {
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
