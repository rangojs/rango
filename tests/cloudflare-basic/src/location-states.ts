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

export interface ListState {
  label: string;
  loaded: number;
}

/**
 * ListLocationState - "load more" list state written by router.push() /
 * router.replace() as a typed entry (`[ListLocationState(value)]`).
 */
export const ListLocationState = createLocationState<ListState>();

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

export interface TxWhenStateShape {
  animate: boolean;
}

/**
 * transition({ when }) reads it from the destination
 * (TxWhenState.read(ctx.to)): a Link carrying { animate: false } gates its
 * navigation off (src/components/transition-when.ts).
 */
export const TxWhenState = createLocationState<TxWhenStateShape>();

export interface PprExecMarkShape {
  middleware: number;
}

/**
 * Set by the exec-matrix middleware on every request. A partial navigation
 * carries it to the browser as metadata.locationState, where the route's
 * transition({ when }) reads it from `to.state`, a PPR replay HIT included.
 */
export const PprExecMark = createLocationState<PprExecMarkShape>();

// Persistent slot read by a useLocationState reader inside a Suspense boundary
// that hydrates after the root (#992).
export const LateSuspenseState = createLocationState<{ label: string }>();

/**
 * #994 "load more": the items of the pages already on screen ride along on
 * the Link. The server renders only the page its URL names, so the slot must
 * not come back after a document load.
 */
export const CarriedItems = createLocationState<string[]>({
  clearOnReload: true,
});

/**
 * Written by the same Link without options: survives a document load. The e2e
 * reads it to know the client snapshots are applied before it asserts that
 * another slot stayed empty.
 */
export const ListSort = createLocationState<{ order: string }>();

/**
 * Set by the load-more handler on every request (ctx.setLocationState). A
 * document response carries no location state, so it reaches the client only
 * with a client navigation's payload, after start-up removed the stale slot.
 */
export const ServerPageStamp = createLocationState<{ page: number }>({
  clearOnReload: true,
});

export interface GridSnapshot {
  order: "asc" | "desc";
  page: number;
}

/**
 * #994: the e2e stores what other deploys of this definition would have, under
 * version 1's key and under the key from before it had a version.
 */
export const VersionedGrid = createLocationState<GridSnapshot>({ version: 2 });

/**
 * Unguarded on purpose: a slot that is not an object makes it throw, which
 * must read as undefined instead of failing the render.
 */
export function isGridSnapshot(value: unknown): value is GridSnapshot {
  const grid = value as GridSnapshot;
  return (
    (grid.order === "asc" || grid.order === "desc") &&
    typeof grid.page === "number"
  );
}

export const ValidatedGrid = createLocationState<GridSnapshot>({
  validate: isGridSnapshot,
});
