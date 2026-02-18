/**
 * Client Segment Runtime - Type Definitions
 *
 * Zero dependencies. All types for the transaction-based runtime:
 * Transaction, RouteSnapshot, ClientRuntimeState, events, commands.
 */

import type { ReactNode, ComponentType } from "react";
import type { ResolvedSegment, SlotState } from "../../types.js";
import type {
  HandleData,
  NavigateOptions,
  HistoryState,
} from "../types.js";

// Re-export for convenience within the runtime module
export type { ResolvedSegment, SlotState, HandleData, NavigateOptions, HistoryState };

// ---------------------------------------------------------------------------
// Structural Signature
// ---------------------------------------------------------------------------

/**
 * Captures the properties of a segment that determine React tree depth.
 * Changing any of these for a retained node causes a remount.
 *
 * loadingCategory:
 *   "none"       = loading is undefined/null (OutletProvider only)
 *   "suppressed" = loading is false (LoaderBoundary + Suspense, no RouteContentWrapper)
 *   "active"     = loading is truthy ReactNode (full nesting)
 */
export interface StructuralSignature {
  kind: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  loadingCategory: "none" | "suppressed" | "active";
  hasMountPath: boolean;
  hasComponent: boolean;
  slot?: string;
}

// ---------------------------------------------------------------------------
// RouteSnapshot
// ---------------------------------------------------------------------------

/**
 * Canonical client state for a single route view.
 * Source of truth for render input, history cache, popstate restore, and
 * revalidation target.
 */
export interface RouteSnapshot {
  /** History key (pathname + search + intercept suffix) */
  key: string;
  /** Full URL string */
  url: string;
  /** Server match order, preserved for rendering */
  matched: string[];
  /** Flat segment array, same shape as current system */
  segments: ResolvedSegment[];
  /** O(1) lookup: segment id -> index in segments[] */
  segmentIndex: Map<string, number>;
  /** Invariant-relevant state per segment */
  signatures: Map<string, StructuralSignature>;
  /** Intercept segments (explicit, not filtered by ID pattern) */
  interceptSegments: ResolvedSegment[];
  /** Intercept slot state */
  slots: Record<string, SlotState>;
  /** Route metadata for useHandle */
  handleData?: HandleData;
  /** Source URL when this is an intercept route */
  interceptSourceUrl?: string | null;
  /** Server RSC version */
  version?: string;
  /** Timestamp when snapshot was created/updated */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export type TxPhase =
  | "created"
  | "fetching"
  | "streaming"
  | "received"
  | "committed"
  | "aborted"
  | "failed";

export type TxKind = "nav" | "action" | "revalidate" | "hmr";

/**
 * Isolation determines how transactions of the same kind interact.
 *   "exclusive"  - new tx aborts all active tx of same kind (navigation: switchMap)
 *   "concurrent" - multiple tx coexist (actions: mergeMap)
 *   "background" - does not affect UI phase (stale revalidation)
 */
export type TxIsolation = "exclusive" | "concurrent" | "background";

export interface Transaction {
  txId: string;
  kind: TxKind;
  isolation: TxIsolation;
  phase: TxPhase;

  /** tx's own epoch (navEpoch or actionEpoch at creation) */
  epoch: number;
  /** navEpoch when tx was created (for detecting nav-away during action) */
  navEpochAtStart: number;

  /** Full URL for this operation */
  url: string;
  /** state.current at tx creation (base for reconcile) */
  blueprintSnapshot: RouteSnapshot;
  /** Timestamp */
  startedAt: number;

  /** Navigation: cache hit rendered before server response */
  optimisticSnapshot?: RouteSnapshot;
  /** Navigation options (uses runtime NavOptions, not browser NavigateOptions) */
  navOptions?: NavOptions;

  /** Action: server action function ID */
  actionId?: string;
  /** Action: original arguments */
  actionArgs?: unknown[];

  /** Revalidation: which cache key this targets */
  targetCacheKey?: string;

  /** Response stored at "received" phase for deferred commit */
  resultPatch?: ServerPatch;
  /** Action return value */
  resultReturnValue?: unknown;
  /** Error payload */
  resultError?: unknown;

  /** Whether an RSC stream is actively being read */
  hasActiveStream: boolean;

  /** Parent tx linkage (e.g., consolidation revalidate linked to action) */
  parentTxId?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface CacheEntry {
  snapshot: RouteSnapshot;
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Runtime State
// ---------------------------------------------------------------------------

export interface HandleState {
  data: HandleData;
  /** Route/layout segment order (no parallels/loaders) */
  segmentOrder: string[];
}

export interface ClientRuntimeState {
  /** Current committed snapshot */
  current: RouteSnapshot;

  /** All active and recently-terminal transactions */
  transactions: Map<string, Transaction>;

  /** Monotonic counters */
  navEpoch: number;
  actionEpoch: number;
  txCounter: number;

  /** LRU cache, mutated directly by reducer */
  cache: Map<string, CacheEntry>;
  cacheMaxSize: number;

  /** Derived from transactions (recomputed every reduce step) */
  phase: "idle" | "loading" | "streaming";
  pendingUrl: string | null;

  /** Route metadata for useHandle */
  handleState: HandleState;

  /** Source URL for intercept context */
  interceptSourceUrl: string | null;

  /** Network error for root error boundary */
  networkError: Error | null;
}

// ---------------------------------------------------------------------------
// Server Patch (adapted from RSC response, no protocol change)
// ---------------------------------------------------------------------------

export interface ServerPatch {
  isPartial: boolean;
  matched: string[];
  diff: string[];
  segments: ResolvedSegment[];
  slots?: Record<string, SlotState>;
  handles?: AsyncGenerator<HandleData, void, unknown>;
  cachedHandleData?: HandleData;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface NavOptions {
  replace?: boolean;
  scroll?: boolean;
  skipLoadingState?: boolean;
  interceptSourceUrl?: string;
}

export interface InterceptHistoryState {
  interceptSourceUrl: string;
  slots?: Record<string, SlotState>;
}

export type RuntimeEvent =
  // Navigation
  | { type: "NAV_START"; url: string; options: NavOptions }
  | { type: "NAV_RESPONSE"; txId: string; patch: ServerPatch }
  // Popstate
  | { type: "POPSTATE"; url: string; historyKey: string; interceptState?: InterceptHistoryState }
  // Actions
  | { type: "ACTION_START"; actionId: string; args: unknown[] }
  | { type: "ACTION_RESPONSE"; txId: string; patch: ServerPatch; returnValue: unknown }
  | { type: "ACTION_ERROR_RESPONSE"; txId: string; patch: ServerPatch; error: unknown }
  // Revalidation
  | { type: "REVALIDATE_DONE"; txId: string; patch: ServerPatch }
  // Streaming
  | { type: "STREAM_START"; txId: string }
  | { type: "STREAM_END"; txId: string }
  // HMR
  | { type: "HMR_UPDATE" }
  | { type: "SEGMENTS_MISSING"; txId: string; missing: string[] }
  // Handles
  | { type: "HANDLES_UPDATE"; txId: string; handles: HandleData; matched?: string[] }
  // Cross-tab
  | { type: "CROSS_TAB_INVALIDATION"; path: string; segmentIds: string[] }
  // Cache control
  | { type: "CACHE_CLEAR_REQUESTED" }
  // Lifecycle
  | { type: "TX_ABORT_REQUESTED"; txId: string }
  | { type: "NETWORK_ERROR"; txId: string; error: Error }
  | { type: "VERSION_MISMATCH"; reloadUrl: string };

// ---------------------------------------------------------------------------
// Commands (true side effects only)
// ---------------------------------------------------------------------------

export interface FetchCommand {
  txId: string;
  url: string;
  /** Empty array = full fetch (server sends everything) */
  segmentIds: string[];
  previousUrl: string;
  mode: "nav" | "action" | "revalidate" | "hmr";
  headers?: Record<string, string>;
}

export interface RenderCommand {
  snapshot: RouteSnapshot;
  /** true for popstate: pre-resolve loaders, no suspense */
  forceAwait: boolean;
}

export interface HistoryCommand {
  url: string;
  key: string;
  state: unknown;
}

export type RuntimeCommand =
  | { kind: "FETCH"; payload: FetchCommand }
  | { kind: "ABORT_FETCH"; payload: { txId: string } }
  | { kind: "RENDER"; payload: RenderCommand }
  | { kind: "PUSH_HISTORY"; payload: HistoryCommand }
  | { kind: "REPLACE_HISTORY"; payload: HistoryCommand }
  | { kind: "BROADCAST_INVALIDATION"; payload: { path: string; segmentIds: string[] } }
  | { kind: "SCROLL"; payload: { behavior: "top" | "restore" | "none" } }
  | { kind: "HARD_RELOAD"; payload: { url: string } };

// ---------------------------------------------------------------------------
// Commit Gate
// ---------------------------------------------------------------------------

export type CommitRejection =
  | "TX_ABORTED"
  | "TX_FAILED"
  | "NAV_EPOCH_STALE"
  | "ACTION_NAVIGATED_AWAY"
  | "REVALIDATE_KEY_MISMATCH"
  | "CONCURRENT_PENDING";

export type CommitDecision =
  | { allowed: true }
  | { allowed: false; reason: CommitRejection; action: "abort" | "ignore" };

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type ReconcileFailure =
  | "MISSING_MATCHED_SEGMENT"
  | "STRUCTURE_VIOLATION"
  | "REQUIRES_FULL_REFETCH";

export type ReconcileResult =
  | { ok: true; snapshot: RouteSnapshot }
  | { ok: false; reason: ReconcileFailure; details: string };

export type ReconcileMode = "navigate" | "action" | "revalidate";

// ---------------------------------------------------------------------------
// Derived state (for hooks)
// ---------------------------------------------------------------------------

export interface DerivedActionState {
  state: "idle" | "loading" | "streaming";
  actionId: string | null;
  payload: unknown[] | null;
  error: unknown | null;
  result: unknown | null;
}

export interface DerivedSegmentState {
  path: string;
  currentUrl: string;
  currentSegmentIds: string[];
}

// ---------------------------------------------------------------------------
// Render Plan (input for segment-system.tsx)
// ---------------------------------------------------------------------------

export interface RenderPlan {
  segments: ResolvedSegment[];
  interceptSegments: ResolvedSegment[];
  options: {
    forceAwait: boolean;
    scrollBehavior: "top" | "restore" | "none";
  };
}

// ---------------------------------------------------------------------------
// Reducer signature
// ---------------------------------------------------------------------------

export interface ReduceResult {
  state: ClientRuntimeState;
  commands: RuntimeCommand[];
}
