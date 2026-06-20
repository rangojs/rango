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
