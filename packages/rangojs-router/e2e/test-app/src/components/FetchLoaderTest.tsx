"use client";

import { useFetchLoader, type LoaderDefinition } from "@rangojs/router/client";

interface FetchLoaderTestProps {
  loader: LoaderDefinition<{
    message: string;
    id: string;
    count: number;
    timestamp: string;
  }>;
}

export function FetchLoaderTest({ loader }: FetchLoaderTestProps) {
  const { data, isLoading, error, load } = useFetchLoader(loader);

  return (
    <div data-testid="fetch-loader-test">
      <h3>useFetchLoader Test</h3>

      {isLoading && <p data-testid="fetch-loader-loading">Loading...</p>}

      {error && (
        <p data-testid="fetch-loader-error" style={{ color: "red" }}>
          Error: {error.message}
        </p>
      )}

      {data && (
        <div data-testid="fetch-loader-data">
          <p data-testid="fetch-loader-message">{data.message}</p>
          <p data-testid="fetch-loader-id">ID: {data.id}</p>
          <p data-testid="fetch-loader-count">Count: {data.count}</p>
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="fetch-loader-btn-default"
          onClick={() => load()}
        >
          Fetch (default)
        </button>
        <button
          data-testid="fetch-loader-btn-custom"
          onClick={() => load({ params: { id: "custom-123" } })}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch (custom ID)
        </button>
        <button
          data-testid="fetch-loader-btn-refetch"
          onClick={() => load({ params: { id: "refetch" } })}
          style={{ marginLeft: "0.5rem" }}
        >
          Refetch
        </button>
      </div>
    </div>
  );
}
