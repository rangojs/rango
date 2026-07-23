import { createLocationState } from "@rangojs/router";

export interface FeatureState {
  name: string;
  description: string;
}

/**
 * FeatureLocationState - passes feature info during navigation.
 * Used to show feature details immediately in loading states.
 *
 * The key is auto-generated from file path + export name.
 */
export const FeatureLocationState = createLocationState<FeatureState>();

export interface ActionFlashState {
  message: string;
}

/**
 * ActionFlash - location state set by a server action (non-redirect flow).
 * Used to verify that action-set location state reaches the client
 * through the revalidation payload.
 */
export const ActionFlash = createLocationState<ActionFlashState>();

export interface ConcurrentSlotState {
  value: string;
}

/**
 * Two distinct slots written by concurrent server actions. Distinct keys must
 * both survive consolidation; the same key resolves to the last-initiated
 * action regardless of settle order.
 */
export const ConcurrentSlotA = createLocationState<ConcurrentSlotState>();
export const ConcurrentSlotB = createLocationState<ConcurrentSlotState>();

export interface NonSerializableStateShape {
  text: string;
  bad: unknown;
}

/**
 * Slot whose declared shape allows an arbitrary `bad` payload. The redirect
 * onError e2e stores a value React Flight cannot serialize (a function) here so
 * createRedirectFlightResponse's renderToReadableStream errors under workerd
 * during real async serialization, and the failure must surface through
 * onError("rendering").
 */
export const NonSerializableState =
  createLocationState<NonSerializableStateShape>();
