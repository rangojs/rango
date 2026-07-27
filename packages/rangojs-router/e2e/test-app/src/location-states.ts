import { createLocationState } from "@rangojs/router";

export interface SlowProductState {
  productName: string;
  productPrice: number;
}

export const SlowProductLocationState = createLocationState<SlowProductState>();

export interface PrerenderTestState {
  tag: string;
}

export const PrerenderTestLocationState =
  createLocationState<PrerenderTestState>();

export interface FlashMessageState {
  text: string;
}

export const FlashMessage = createLocationState<FlashMessageState>({
  flash: true,
});

export interface ServerInfoState {
  data: string;
}

export const ServerInfo = createLocationState<ServerInfoState>();

export interface StaticWriteDemoState {
  label: string;
  count: number;
}

export const StaticWriteDemo = createLocationState<StaticWriteDemoState>();

export interface ActionInfoStateShape {
  value: string;
}

// Two distinct, non-flash slots written by concurrent server actions in the
// action-ls fixture. Distinct keys must both survive consolidation; the same
// key resolves to the last-initiated action.
export const ActionInfoA = createLocationState<ActionInfoStateShape>();
export const ActionInfoB = createLocationState<ActionInfoStateShape>();

// Group (clientUrls) location-state slots. Groups have no handlers, so their
// server write surface for location state is exactly two lanes: action writes
// (in-place merge on settle) and redirect()-carried state (action or loader
// redirects). CuFlash is the redirect-delivered flash; CuNote is the
// non-flash slot an action writes in place.
export interface CuFlashStateShape {
  text: string;
}

export const CuFlash = createLocationState<CuFlashStateShape>({ flash: true });

export interface CuNoteStateShape {
  value: string;
}

export const CuNote = createLocationState<CuNoteStateShape>();

// Slot whose declared shape allows an arbitrary `bad` payload. The redirect
// onError e2e stores a value React Flight cannot serialize (a function) here,
// so createRedirectFlightResponse's renderToReadableStream errors during real
// async serialization and the failure must surface through onError("rendering").
export interface NonSerializableStateShape {
  text: string;
  bad: unknown;
}

export const NonSerializableState =
  createLocationState<NonSerializableStateShape>();
