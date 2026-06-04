"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { FetchableLoader } from "../loaders.js";

// Fetches the fetchable loader on demand (GET) via useFetchLoader.
export function FetchWidget() {
  const { data, isLoading, error, load } = useFetchLoader(FetchableLoader);

  return (
    <div data-testid="fetch-widget">
      {isLoading && <p data-testid="fetch-loading">Loading...</p>}
      {error && <p data-testid="fetch-error">Error: {error.message}</p>}
      {data && (
        <div data-testid="fetch-data">
          <span data-testid="fetch-message">{data.message}</span>{" "}
          <span data-testid="fetch-id">{data.id}</span>{" "}
          <span data-testid="fetch-count">{data.count}</span>
        </div>
      )}
      <button data-testid="fetch-default" onClick={() => load()}>
        Fetch
      </button>
      <button
        data-testid="fetch-custom"
        onClick={() => load({ params: { id: "custom-123" } })}
      >
        Fetch custom
      </button>
    </div>
  );
}
