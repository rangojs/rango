"use client";

import { useLoader } from "@rangojs/router/client";
import {
  ClientThemeLoader,
  IsomorphicCartLoader,
  ServerOnlyTestLoader,
} from "../client-loaders.js";
import { IsolatedIsomorphicLoader } from "../isolated-isomorphic-loader.js";

/**
 * Client component that displays client loader data.
 * Imports ClientThemeLoader directly so the module is in the client bundle,
 * which registers the client function in the browser-side registry.
 */
export function ClientThemeContent() {
  const { data, refetch, isLoading } = useLoader(ClientThemeLoader);
  if (!data) {
    return <div data-testid="client-loader-pending">Loading theme...</div>;
  }
  return (
    <div data-testid="client-loader-content">
      <p data-testid="client-loader-theme">Theme: {data.theme}</p>
      <p data-testid="client-loader-source">Source: {data.source}</p>
      <p data-testid="client-loader-timestamp">Timestamp: {data.timestamp}</p>
      <button
        data-testid="client-loader-refetch"
        onClick={() => refetch()}
        disabled={isLoading}
      >
        Refetch
      </button>
      <p data-testid="client-loader-loading">
        {isLoading ? "loading" : "idle"}
      </p>
    </div>
  );
}

/**
 * Client component that displays isomorphic loader data.
 * useLoader works the same regardless of where data came from.
 */
export function IsomorphicCartContent() {
  const { data } = useLoader(IsomorphicCartLoader);
  if (!data) {
    return <div data-testid="isomorphic-loader-pending">Loading cart...</div>;
  }
  return (
    <div data-testid="isomorphic-loader-content">
      <p data-testid="isomorphic-loader-total">Total: {data.total}</p>
      <p data-testid="isomorphic-loader-source">Source: {data.source}</p>
      <p data-testid="isomorphic-loader-items">
        Items: {data.items.join(", ")}
      </p>
      <p data-testid="isomorphic-loader-timestamp">
        Timestamp: {data.timestamp}
      </p>
    </div>
  );
}

/**
 * Client component for an export-only isomorphic loader file.
 * Verifies that the Vite plugin preserves client fn registration
 * even when the loader file has no other exports.
 */
export function IsolatedIsomorphicContent() {
  const { data } = useLoader(IsolatedIsomorphicLoader);
  if (!data) {
    return <div data-testid="isolated-isomorphic-pending">Loading...</div>;
  }
  return (
    <div data-testid="isolated-isomorphic-content">
      <p data-testid="isolated-isomorphic-value">Value: {data.value}</p>
      <p data-testid="isolated-isomorphic-source">Source: {data.source}</p>
    </div>
  );
}

/**
 * Client component displaying both a server loader and a client loader.
 */
export function MixedLoaderContent() {
  const { data: serverData } = useLoader(ServerOnlyTestLoader);
  const { data: clientData } = useLoader(ClientThemeLoader);
  if (!clientData) {
    return <div data-testid="mixed-loader-pending">Loading client data...</div>;
  }
  return (
    <div data-testid="mixed-loader-content">
      <div data-testid="mixed-server-data">
        <p data-testid="mixed-server-source">
          Server source: {serverData.source}
        </p>
        <p data-testid="mixed-server-message">
          Server message: {serverData.message}
        </p>
      </div>
      <div data-testid="mixed-client-data">
        <p data-testid="mixed-client-source">
          Client source: {clientData.source}
        </p>
        <p data-testid="mixed-client-theme">Client theme: {clientData.theme}</p>
      </div>
    </div>
  );
}
