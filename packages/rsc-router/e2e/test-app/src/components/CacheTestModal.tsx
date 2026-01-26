"use client";

import { useLoader, type LoaderDefinition } from "@ivogt/rsc-router/client";
import type { InterceptCacheTestLoaderData } from "../loaders.js";

interface CacheTestModalProps {
  data: InterceptCacheTestLoaderData;
  testId?: string;
}

/**
 * Client component for testing intercept caching.
 *
 * Receives loader data as props from the RSC component which fetches
 * the data via ctx.use(). This allows testing that the segment is cached
 * while the loader data is fresh (loaders excluded from segment cache).
 */
export function CacheTestModal({ data, testId = "cache-test-modal" }: CacheTestModalProps) {
  return (
    <div
      data-testid={testId}
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "white",
        padding: "2rem",
        borderRadius: "8px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
        zIndex: 1000,
        minWidth: "300px",
      }}
    >
      <div data-testid={`${testId}-header`}>
        <span data-testid={`${testId}-indicator`}>Cache Test Intercept</span>
        <h2 data-testid={`${testId}-title`}>Intercept Modal</h2>
      </div>

      <div data-testid={`${testId}-content`}>
        <p data-testid={`${testId}-count`}>Count: {data.count}</p>
        <p data-testid={`${testId}-message`}>{data.message}</p>
        <p data-testid={`${testId}-loaded-at`}>Loaded: {data.loadedAt}</p>
      </div>
    </div>
  );
}

interface UseLoaderModalProps {
  loader: LoaderDefinition<InterceptCacheTestLoaderData>;
  testId?: string;
}

/**
 * Client component that uses useLoader to get data from context.
 * Requires loader() to be registered on the route so data is in context.
 */
export function UseLoaderModal({ loader, testId = "useloader-modal" }: UseLoaderModalProps) {
  const { data } = useLoader<InterceptCacheTestLoaderData>(loader);

  return (
    <div
      data-testid={testId}
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "white",
        padding: "2rem",
        borderRadius: "8px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
        zIndex: 1000,
        minWidth: "300px",
      }}
    >
      <div data-testid={`${testId}-header`}>
        <span data-testid={`${testId}-indicator`}>useLoader Modal</span>
        <h2 data-testid={`${testId}-title`}>Modal with useLoader</h2>
      </div>

      <div data-testid={`${testId}-content`}>
        <p data-testid={`${testId}-count`}>Count: {data.count}</p>
        <p data-testid={`${testId}-message`}>{data.message}</p>
        <p data-testid={`${testId}-loaded-at`}>Loaded: {data.loadedAt}</p>
      </div>
    </div>
  );
}
