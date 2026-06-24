"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { OrphanFetchableLoader } from "../orphan-loader.js";

/**
 * Client component for the orphan fetchable loader reproduction.
 *
 * It imports OrphanFetchableLoader directly. In every non-RSC build the import
 * resolves to a generated { __brand, $$id } stub, so the loader function never
 * ships to the client — load() just reads $$id and fetches the _rsc_loader
 * endpoint. This is the only place the orphan loader module is imported, and it
 * is a client import, so the loader's real code stays out of the RSC graph.
 */
export function OrphanFetchLoaderTest() {
  const { data, isLoading, error, load } = useFetchLoader(
    OrphanFetchableLoader,
  );

  return (
    <div data-testid="orphan-fetch-test">
      <h3 data-testid="orphan-fetch-title">Orphan Fetchable Loader Test</h3>

      {isLoading && <p data-testid="orphan-fetch-loading">Loading...</p>}

      {error && (
        <p data-testid="orphan-fetch-error" style={{ color: "red" }}>
          Error: {error.message}
        </p>
      )}

      {data && (
        <div data-testid="orphan-fetch-data">
          <p data-testid="orphan-fetch-message">{data.message}</p>
          <p data-testid="orphan-fetch-id">ID: {data.id}</p>
          <p data-testid="orphan-fetch-count">Count: {data.count}</p>
        </div>
      )}

      <button data-testid="orphan-fetch-btn" onClick={() => load()}>
        Fetch orphan
      </button>
    </div>
  );
}
