"use client";

import { useLocationState } from "@rangojs/router/client";
import { FeatureLocationState } from "../location-states.js";

// Loading fallback for /features/:slug. When reached via a Link that carried
// FeatureLocationState, the feature name is shown immediately while the handler
// resolves; on a cold load (no nav state) a skeleton shows instead.
export function FeatureLoading() {
  const state = useLocationState(FeatureLocationState);

  return (
    <div data-testid="feature-loading">
      {state ? (
        <h1 data-testid="feature-loading-name">{state.name}</h1>
      ) : (
        <div data-testid="feature-loading-skeleton">Loading...</div>
      )}
    </div>
  );
}
