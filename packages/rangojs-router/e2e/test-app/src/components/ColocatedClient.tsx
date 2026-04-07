"use client";

// This is the key test: directly importing a loader and handle from a file
// that also exports a Prerender() handler. The Vite plugin's non-RSC transform
// may return early when stubbing the Prerender, skipping $$id injection
// for the loader and handle.
import {
  ColocatedLoader,
  ColocatedHandle,
} from "../urls/colocated-loader-prerender.defs.js";
import { useLoader } from "@rangojs/router/client";

export function ColocatedClient() {
  const { data } = useLoader(ColocatedLoader);

  return (
    <div data-testid="colocated-client">
      <p data-testid="colocated-client-message">{data.message}</p>
      <p data-testid="colocated-client-ts">{data.ts}</p>
      <pre data-testid="colocated-loader-id">
        {String((ColocatedLoader as any)?.$$id ?? "no-loader-id")}
      </pre>
      <pre data-testid="colocated-handle-id">
        {String((ColocatedHandle as any)?.$$id ?? "no-handle-id")}
      </pre>
    </div>
  );
}
