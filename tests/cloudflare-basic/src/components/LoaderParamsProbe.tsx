"use client";

import { Component, useState, type ReactNode } from "react";
import { useFetchLoader } from "@rangojs/router/client";
import { LoaderParamsLoader } from "../loaders/loader-params.js";

/**
 * Fetchable-loader params are string values (#1109). Anything else is a 400
 * carrying a loader error, so load() rejects with the router's
 * "Invalid loader params" message, and the hook (throwOnError defaults to
 * true) throws it to the nearest error boundary.
 */
export function LoaderParamsProbe() {
  const [rejection, setRejection] = useState<string | null>(null);
  return (
    <div data-testid="loader-params-probe">
      {rejection !== null && (
        <p data-testid="loader-params-rejection">{rejection}</p>
      )}
      <ParamsBoundary>
        <ParamsLoad onReject={setRejection} />
      </ParamsBoundary>
    </div>
  );
}

function ParamsLoad({ onReject }: { onReject: (message: string) => void }) {
  const { data, load } = useFetchLoader(LoaderParamsLoader);
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

/**
 * A local boundary, not the router's ErrorBoundary: nothing else in this app
 * imports that, and the client router chunk ratchet
 * (tools/check-bundle-guards.mjs) would count it.
 */
class ParamsBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    return this.state.error ? (
      <p data-testid="loader-params-boundary">{this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}
