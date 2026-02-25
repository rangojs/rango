"use client";

import { useEffect, useState } from "react";
import { useSegments } from "@rangojs/router/client";

/**
 * Debug component to display current segments state
 * Uses suppressHydrationWarning for dynamic content that differs SSR vs client
 */
export function SegmentsDisplay() {
  const { path, segmentIds, location } = useSegments();

  return (
    <div
      data-testid="segments-display"
      style={{
        fontSize: "12px",
        padding: "8px",
        background: "#f5f5f5",
        marginTop: "8px",
      }}
    >
      <div data-testid="segments-path">
        <strong>Path:</strong> {JSON.stringify(path)}
      </div>
      <div data-testid="segments-ids">
        <strong>Segment IDs:</strong> {segmentIds.join(", ") || "(none)"}
      </div>
      <div data-testid="segments-pathname">
        <strong>Pathname:</strong> {location.pathname}
      </div>
    </div>
  );
}

/**
 * Component that uses selector for specific value
 */
export function PathDisplay() {
  const path = useSegments((s) => s.path);
  return <span data-testid="path-only">/{path.join("/")}</span>;
}

/**
 * Component that checks if on a specific route
 */
export function IsProductRoute() {
  const isProduct = useSegments((s) => s.path[0] === "product");
  return <span data-testid="is-product-route">{isProduct ? "Yes" : "No"}</span>;
}
