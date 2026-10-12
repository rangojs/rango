import { useLocationState } from "@rangojs/router/client";
import { GatedHydrationState } from "../location-states.js";

/** The gated boundary's content: hydrates once its chunk is let through. */
export function GatedHydrationContent() {
  const state = useLocationState(GatedHydrationState);
  return <span data-testid="gated-inside">{state?.label ?? "empty"}</span>;
}
