"use client";

import { useState } from "react";
import {
  ErrorBoundary,
  useFetchLoader,
  type LoaderDefinition,
} from "@rangojs/router/client";

/**
 * Fetchable-loader params are string values (#1109). Anything else is a 400
 * carrying a loader error, so load() rejects with the router's
 * "Invalid loader params" message, and the hook (throwOnError defaults to
 * true) throws it to the nearest error boundary.
 */
export function LoaderParamsProbe({
  loader,
}: {
  loader: LoaderDefinition<{ id: string }>;
}) {
  const [rejection, setRejection] = useState<string | null>(null);
  return (
    <div data-testid="loader-params-probe">
      {rejection !== null && (
        <p data-testid="loader-params-rejection">{rejection}</p>
      )}
      <ErrorBoundary
        fallback={({ error }) => (
          <p data-testid="loader-params-boundary">{error.message}</p>
        )}
      >
        <ParamsLoad loader={loader} onReject={setRejection} />
      </ErrorBoundary>
    </div>
  );
}

function ParamsLoad({
  loader,
  onReject,
}: {
  loader: LoaderDefinition<{ id: string }>;
  onReject: (message: string) => void;
}) {
  const { data, load } = useFetchLoader(loader);
  const run = (params: Record<string, string>) => {
    load({ params }).catch((error: Error) => onReject(error.message));
  };
  return (
    <div>
      {data && <p data-testid="loader-params-id">{data.id}</p>}
      <button
        data-testid="loader-params-valid"
        onClick={() => run({ id: "valid-1" })}
      >
        Valid params
      </button>
      <button
        data-testid="loader-params-invalid"
        // Untyped code: a number where a string belongs.
        onClick={() => run({ id: 1 } as unknown as Record<string, string>)}
      >
        Invalid params
      </button>
    </div>
  );
}
