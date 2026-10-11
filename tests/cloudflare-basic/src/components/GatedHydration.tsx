"use client";

import { lazy } from "react";
import { useLocationState } from "@rangojs/router/client";
import { GatedHydrationState } from "../location-states.js";

declare global {
  interface Window {
    __openGatedHydrationChunk?: () => void;
  }
}

// The lazy chunk below loads once the e2e calls
// window.__openGatedHydrationChunk(); the server imports it at once. Until
// then the boundary keeps its server HTML, dehydrated.
let openChunk: () => void = () => {};
const chunkOpened: Promise<void> =
  typeof window === "undefined"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        openChunk = resolve;
      });
if (typeof window !== "undefined") {
  window.__openGatedHydrationChunk = () => openChunk();
}

const GatedHydrationContent = lazy(() =>
  chunkOpened
    .then(() => import("./GatedHydrationContent.js"))
    .then((m) => ({ default: m.GatedHydrationContent })),
);

export function GatedHydrationWriter() {
  return (
    <button
      type="button"
      data-testid="gated-write"
      onClick={() => GatedHydrationState.write({ label: "stored-value" })}
    >
      Write state
    </button>
  );
}

/** Outside the gated boundary: hydrates with the root. */
export function GatedHydrationOutside() {
  const state = useLocationState(GatedHydrationState);
  return <span data-testid="gated-outside">{state?.label ?? "empty"}</span>;
}

/**
 * Rendered by the page directly inside its `<Suspense>`, a sibling of the
 * outside reader: a wrapper component between them would let React tell the
 * dehydrated boundary about the reveal transition's context change.
 */
export function GatedHydrationInside() {
  return <GatedHydrationContent />;
}
