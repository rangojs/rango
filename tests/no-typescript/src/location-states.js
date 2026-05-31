import { createLocationState } from "@rangojs/router";

// Set on a Link via state={[FeatureLocationState({...})]} and read in the
// loading fallback with useLocationState(FeatureLocationState).
export const FeatureLocationState = createLocationState();

// Set by a server action via ctx.setLocationState([ActionFlash({...})]) and
// read on the client with useLocationState(ActionFlash).
export const ActionFlash = createLocationState();
