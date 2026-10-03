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

// transition({ when }) reads it from the destination (TxWhenState.read(ctx.to)):
// a Link carrying { animate: false } gates its navigation off.
export interface TxWhenStateShape {
  animate: boolean;
}

export const TxWhenState = createLocationState<TxWhenStateShape>();

// Persistent slot read by a useLocationState reader inside a Suspense boundary
// that hydrates after the root (#992).
export const LateSuspenseState = createLocationState<{ label: string }>();

// #994 "load more": the items of the pages already on screen ride along on the
// Link. The server renders only the page its URL names, so the slot must not
// come back after a document load.
export const CarriedItems = createLocationState<string[]>({
  clearOnReload: true,
});

// Written by the same Link without options: survives a document load. The
// e2e reads it to know the client snapshots are applied before it asserts
// that another slot stayed empty.
export const ListSort = createLocationState<{ order: string }>();

// Set by the load-more handler on every request (ctx.setLocationState). A
// document response carries no location state, so it reaches the client only
// with a client navigation's payload, after start-up removed the stale slot.
export const ServerPageStamp = createLocationState<{ page: number }>({
  clearOnReload: true,
});

export interface GridSnapshot {
  order: "asc" | "desc";
  page: number;
}

// #994: no options. The e2e rewrites the app version its entry records, the
// way an entry an older build wrote would carry another one.
export const GridState = createLocationState<GridSnapshot>();

// Unguarded on purpose: a slot that is not an object makes it throw, which
// must read as undefined instead of failing the render.
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
