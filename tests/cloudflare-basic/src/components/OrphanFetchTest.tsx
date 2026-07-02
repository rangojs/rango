"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { OrphanFetchableLoader } from "../loaders/orphan-fetchable.js";

/**
 * Client component for the orphan fetchable loader reproduction. It is the only
 * importer of OrphanFetchableLoader. Because this is a client import, the loader
 * function never enters the worker (RSC) module graph through an import — the
 * client build replaces it with a { __brand, $$id } stub and load() fetches the
 * _rsc_loader endpoint by id.
 */
export function OrphanFetchTest() {
  const { data, isLoading, error, load } = useFetchLoader(
    OrphanFetchableLoader,
  );

  return (
    <div data-testid="orphan-fetch-test">
      <h3 data-testid="orphan-fetch-title">Orphan Fetchable Loader</h3>

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
        </div>
      )}

      <button data-testid="orphan-fetch-btn" onClick={() => load()}>
        Fetch orphan
      </button>
    </div>
  );
}
