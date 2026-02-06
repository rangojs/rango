"use client";

import { useLocationState } from "@rangojs/router/client";
import { FeatureLocationState } from "../location-states.js";

/**
 * FeatureLoading - displays feature info from location state during loading.
 * Uses useLocationState to access state passed during navigation.
 */
export function FeatureLoading() {
  const state = useLocationState(FeatureLocationState);

  return (
    <main data-testid="feature-loading">
      {state ? (
        <>
          <h1 data-testid="feature-loading-name">{state.name}</h1>
          <p
            data-testid="feature-loading-description"
            style={{ marginBottom: "1rem", color: "#666" }}
          >
            {state.description}
          </p>
          <div
            style={{
              width: "100%",
              height: "16px",
              background: "#e0e0e0",
              borderRadius: "4px",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        </>
      ) : (
        <>
          <div
            data-testid="feature-loading-skeleton-name"
            style={{
              width: "250px",
              height: "32px",
              background: "#e0e0e0",
              marginBottom: "1rem",
              borderRadius: "4px",
            }}
          />
          <div
            data-testid="feature-loading-skeleton-description"
            style={{
              width: "350px",
              height: "16px",
              background: "#e0e0e0",
              marginBottom: "1rem",
              borderRadius: "4px",
            }}
          />
          <div
            style={{
              width: "100%",
              height: "16px",
              background: "#e0e0e0",
              borderRadius: "4px",
            }}
          />
        </>
      )}
    </main>
  );
}
