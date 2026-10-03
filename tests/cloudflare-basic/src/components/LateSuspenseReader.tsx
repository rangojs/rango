"use client";

import { useLocationState } from "@rangojs/router/client";
import { LateSuspenseState } from "../location-states.js";

export function LateSuspenseWriter() {
  return (
    <button
      type="button"
      data-testid="late-ls-write"
      onClick={() => LateSuspenseState.write({ label: "stored-value" })}
    >
      Write state
    </button>
  );
}

/**
 * Rendered inside a <Suspense> whose server content resolves after the root
 * has hydrated. The hydrating render must be `undefined` (what SSR produced);
 * the stored value appears on the next render.
 */
export function LateSuspenseReader() {
  const state = useLocationState(LateSuspenseState);
  return (
    <div data-testid="late-ls-reader">
      {state ? (
        <span data-testid="late-ls-value">{state.label}</span>
      ) : (
        <span data-testid="late-ls-empty">empty</span>
      )}
    </div>
  );
}
