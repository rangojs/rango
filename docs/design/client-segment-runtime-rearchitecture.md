# Client Segment Runtime Re-Architecture

## Status
Draft proposal for research and alignment.

## Summary

Replace the current client-side segment system with a **transaction-based runtime** where all behavior lives in pure, unit-testable functions. Every client segment update -- navigation, action, popstate, revalidation, HMR, error recovery -- is a **Transaction** with an explicit lifecycle, commit conditions, and isolation rules.

Core model:

1. **Transaction** as the unit of work. Every operation creates one. It carries its own context (blueprint snapshot, epoch, URL), progresses through phases, and either commits or aborts.
2. **`canCommit()`** as the single commit gate. All staleness checks, epoch guards, and key-match validations live in one pure function.
3. **`reconcileSnapshot()`** as the single merge function. All modes (nav, action, revalidate) use the same code path, parameterized by the transaction's kind.
4. **Reducer** as the sole decision point. `(state, event) => (state, commands)`. Pure, sync, no DOM. Cache and transaction state are mutated directly. Only true side effects (fetch, render, history, broadcast) are emitted as commands.
5. **Logic-free executors** that perform side effects and nothing else.

The runtime is built as a standalone module, verified with unit tests, run in shadow mode alongside old code, then swapped in. The old bridge code is deleted.

## Problem Statement

Current behavior works, but the implementation prevents unit testing and concentrates risk:

1. **Duplicated merge logic with drift risk.**
   `partial-update.ts` and `server-action-bridge.ts` contain near-identical segment merge, loading preservation, mountPath preservation, component-null handling, and loader merge logic. Fixes must be applied to both and kept in sync.

2. **Structural invariants guarded ad hoc.**
   `loading` category and `mountPath` determine React tree depth. This knowledge is spread across `segment-structure-assert.ts` (warns), merge code in both bridges (preserves values), and `segment-system.tsx` (renders based on values). No single source of truth.

3. **ID-shape heuristics in multiple places.**
   Intercept detection (`id.includes(".@")`), loader parent detection (`{parentId}D{index}.{loaderId}`), and segment kind inference all rely on string pattern matching scattered across files.

4. **Scenario-specific branches instead of unified state machine.**
   Popstate stale revalidation, cache-only commits, action-after-navigation recovery, HMR resilience, concurrent action consolidation, and version mismatch reload are each implemented as one-off branches in imperative async functions.

5. **Implicit transaction semantics.**
   Navigation abort, action concurrency, epoch staleness, and streaming lifecycle are implemented as ad-hoc checks scattered across bridges. The same guard logic ("is this response still relevant?") is reimplemented for every response type.

6. **Not unit-testable.**
   The bridges directly call `commitSegments()`, `pushHistoryState()`, `fetchPartial()`, and streaming token APIs. Testing any behavior requires mocking the entire browser environment or running e2e. No way to verify a state transition or commit guard in isolation.

## Goals

1. **Transaction-first.** Every operation is a transaction with explicit lifecycle, isolation rules, and commit conditions. No implicit async coordination.
2. **All behavior in pure functions.** Every decision is testable with `(state, event) => (state, commands)`. No logic in adapters.
3. **Centralized commit gate.** One `canCommit()` function replaces all scattered epoch/staleness/abort checks.
4. **One mechanism for every update type.** Navigation, actions, popstate, stale revalidation, HMR, intercept transitions, error recovery, and cross-tab invalidation all flow through the same reducer and transaction lifecycle.
5. **Preserve tree-shape stability.** Unchanged nodes never remount. Structural invariants are enforced in one place.
6. **Full migration.** Build, verify, swap, delete. No long-lived dual implementation.

## Non-Goals

1. Rewriting server route matching or middleware pipeline.
2. Changing user-facing route APIs (`useNavigation`, `useRouter`, route config).
3. Changing the RSC wire protocol. The new runtime adapts the existing server response format.

## Design Principles

1. **Transactions own context.** Blueprint snapshots, optimistic state, and stream handles live ON the transaction, not as loose state fields. When a tx aborts, all its context is cleaned up in one place.
2. **Reducer owns all decisions.** Side-effect executors are logic-free. If you need an `if` statement, it belongs in the reducer.
3. **Cache and transactions are state, not effects.** The reducer mutates them directly. Only true side effects (network, DOM, cross-tab) are commands.
4. **Structural invariants are data, not code.** `StructuralSignature` is computed once and compared, not re-derived by render logic.
5. **Testability over convenience.** If a behavior can't be tested with a pure function call, redesign until it can.

---

## Architecture

### 1. Transaction (Unit of Work)

Every client-side operation creates a Transaction. The transaction carries all context needed to process its response and decide whether to commit.

```ts
type TxPhase =
  | "created"     // tx registered, fetch not yet started
  | "fetching"    // network request in flight
  | "streaming"   // RSC stream actively being read
  | "received"    // response arrived, pending commit (used for concurrent action batching)
  | "committed"   // applied to current snapshot + rendered
  | "aborted"     // cancelled (superseded, navigated away, or explicit abort)
  | "failed";     // unrecoverable error

type TxKind = "nav" | "action" | "revalidate" | "hmr";

// Isolation determines how transactions of the same kind interact.
//   "exclusive": new tx aborts all active tx of same kind (navigation: switchMap).
//   "concurrent": multiple tx coexist (actions: mergeMap).
//   "background": does not affect UI phase (stale revalidation).
type TxIsolation = "exclusive" | "concurrent" | "background";

interface Transaction {
  txId: string;
  kind: TxKind;
  isolation: TxIsolation;
  phase: TxPhase;

  // Epochs captured at creation
  epoch: number;                       // tx's own epoch (navEpoch or actionEpoch)
  navEpochAtStart: number;             // navEpoch when tx was created

  // Context captured at creation
  url: string;
  blueprintSnapshot: RouteSnapshot;    // state.current at tx creation (base for reconcile)
  startedAt: number;

  // Navigation-specific (set at creation)
  optimisticSnapshot?: RouteSnapshot;  // cache hit rendered before server response
  navOptions?: NavOptions;             // replace, scroll, skipLoadingState, etc.

  // Action-specific
  actionId?: string;

  // Revalidation-specific
  targetCacheKey?: string;             // which cache entry this revalidation targets

  // Result (set when response arrives)
  resultPatch?: ServerPatch;           // stored at "received" phase for deferred commit
  resultReturnValue?: unknown;         // action return value
  resultError?: unknown;               // error payload

  // Streaming
  hasActiveStream: boolean;

  // Linkage
  parentTxId?: string;                 // e.g., consolidation revalidate linked to action
}
```

**Phase transitions:**

```
created ──→ fetching ──→ streaming ──→ received ──→ committed
   │            │            │            │
   └────────────┴────────────┴────────────┴──→ aborted
   │            │            │
   └────────────┴────────────┴──→ failed
```

**Isolation rules (applied at transaction creation):**

| Kind       | Isolation    | Rule                                                              |
|------------|------------- |-------------------------------------------------------------------|
| nav        | exclusive    | New nav tx aborts ALL active nav tx.                              |
| action     | concurrent   | Coexists with other action tx. Commit deferred until all received.|
| revalidate | background   | No UI phase change. Ignored if target key no longer current.      |
| hmr        | exclusive    | Aborts previous hmr tx.                                           |

### 2. RouteSnapshot (Canonical State)

```ts
interface StructuralSignature {
  kind: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  // "none" = loading is undefined/null (OutletProvider only)
  // "suppressed" = loading is false (LoaderBoundary + Suspense, no wrapper)
  // "active" = loading is truthy ReactNode (full: LoaderBoundary + Suspense + RouteContentWrapper)
  loadingCategory: "none" | "suppressed" | "active";
  hasMountPath: boolean;
  hasComponent: boolean;
  slot?: string;
}

interface RouteSnapshot {
  key: string;                            // history key (pathname + search + intercept suffix)
  url: string;
  matched: string[];                      // server match order, preserved for rendering
  segments: ResolvedSegment[];            // flat array, same shape as current system
  segmentIndex: Map<string, number>;      // O(1) lookup into segments[]
  signatures: Map<string, StructuralSignature>;
  interceptSegments: ResolvedSegment[];   // explicit, not filtered by ID pattern
  slots: Record<string, SlotState>;       // intercept slot state
  handleData?: HandleData;
  interceptSourceUrl?: string | null;
  version?: string;
  updatedAt: number;
}
```

Flat segments array is kept. `segmentIndex` gives O(1) lookup without a graph. `signatures` captures invariant-relevant state separately. `interceptSegments` makes intercepts explicit instead of inferred by `.@` pattern.

### 3. Runtime State

```ts
interface CacheEntry {
  snapshot: RouteSnapshot;
  stale: boolean;
}

interface ClientRuntimeState {
  // Snapshot
  current: RouteSnapshot;

  // Transactions (the central coordination mechanism)
  transactions: Map<string, Transaction>;

  // Epochs (monotonic counters, source of truth for staleness)
  navEpoch: number;
  actionEpoch: number;
  txCounter: number;             // monotonic, used to generate txIds

  // Cache (LRU, mutated directly by reducer)
  cache: Map<string, CacheEntry>;
  cacheMaxSize: number;          // default 20

  // Derived lifecycle (computed from transactions, drives useNavigation() hook)
  phase: "idle" | "loading" | "streaming";
  pendingUrl: string | null;

  // Handle data (route metadata for useHandle hook, e.g. breadcrumbs)
  handleState: {
    data: HandleData;            // handleName -> segmentId -> entries[]
    segmentOrder: string[];      // matched route/layout segments (no parallels/loaders)
  };

  // Intercept context
  interceptSourceUrl: string | null;

  // Errors
  networkError: Error | null;
}
```

**Key design decisions:**

1. **Cache is state, not effects.** The reducer mutates `cache` directly. No CACHE_WRITE / CACHE_MARK_STALE / CACHE_EVICT commands. Only `BROADCAST_INVALIDATION` remains as a command (cross-tab is a true side effect).

2. **`phase` is derived from transactions.** If any non-background tx is in `streaming` phase: `phase = "streaming"`. If any non-background tx is in `fetching` or `created`: `phase = "loading"`. Otherwise: `phase = "idle"`. Computed by a pure `derivePhase(transactions)` function.

3. **`pendingUrl` is derived from transactions.** The URL of the active nav tx (if any).

4. **No separate `inflightActions`, `activeStreams`, `optimisticSnapshot`.** These are all derived from or stored on transactions. One source of truth.

```ts
// Pure derivation functions (unit-testable independently)
function derivePhase(txs: Map<string, Transaction>): "idle" | "loading" | "streaming" { ... }
function derivePendingUrl(txs: Map<string, Transaction>): string | null { ... }
function getActiveNavTx(txs: Map<string, Transaction>): Transaction | undefined { ... }
function getInflightActionTxIds(txs: Map<string, Transaction>): string[] { ... }
function hasActiveStream(txs: Map<string, Transaction>): boolean { ... }
```

### 4. Commit Gate (`canCommit`)

All staleness/epoch/abort guards in one pure function:

```ts
interface CommitDecision =
  | { allowed: true }
  | { allowed: false; reason: CommitRejection; action: "abort" | "ignore" }

type CommitRejection =
  | "TX_ABORTED"              // tx already aborted
  | "TX_FAILED"               // tx already failed
  | "NAV_EPOCH_STALE"         // newer navigation started since this tx
  | "ACTION_NAVIGATED_AWAY"   // user navigated away during action (navEpoch changed)
  | "REVALIDATE_KEY_MISMATCH" // user navigated away, target key no longer current
  | "CONCURRENT_PENDING"      // other action tx still in flight (defer, don't commit yet)

function canCommit(state: ClientRuntimeState, tx: Transaction): CommitDecision {
  // Phase check
  if (tx.phase === "aborted") return { allowed: false, reason: "TX_ABORTED", action: "ignore" };
  if (tx.phase === "failed") return { allowed: false, reason: "TX_FAILED", action: "ignore" };

  // Epoch check (navigation)
  if (tx.kind === "nav" && tx.epoch < state.navEpoch) {
    return { allowed: false, reason: "NAV_EPOCH_STALE", action: "abort" };
  }

  // Revalidation target check
  if (tx.kind === "revalidate" && tx.targetCacheKey !== state.current.key) {
    return { allowed: false, reason: "REVALIDATE_KEY_MISMATCH", action: "abort" };
  }

  // Action: check if user navigated away
  if (tx.kind === "action" && tx.navEpochAtStart !== state.navEpoch) {
    return { allowed: false, reason: "ACTION_NAVIGATED_AWAY", action: "abort" };
  }

  // Action: check if other action tx still in flight (batch commit)
  if (tx.kind === "action") {
    const siblingActions = findActionTxs(state.transactions, tx.txId);
    const anyStillFetching = siblingActions.some(
      s => s.phase === "fetching" || s.phase === "streaming"
    );
    if (anyStillFetching) {
      return { allowed: false, reason: "CONCURRENT_PENDING", action: "ignore" };
    }
  }

  return { allowed: true };
}
```

This is the most critical pure function in the system. Every commit guard the old bridges implement is captured here. Unit tests for `canCommit()` cover every combination of state and transaction.

### 5. Complete Event Catalog

Events are what the outside world sends to the reducer:

```ts
type RuntimeEvent =
  // --- Navigation ---
  | { type: "NAV_START"; url: string; options: NavOptions }
  | { type: "NAV_RESPONSE"; txId: string; patch: ServerPatch }

  // --- Popstate ---
  | { type: "POPSTATE"; url: string; historyKey: string; interceptState?: InterceptHistoryState }

  // --- Actions ---
  | { type: "ACTION_START"; actionId: string }
  | { type: "ACTION_RESPONSE"; txId: string; patch: ServerPatch; returnValue: unknown }
  | { type: "ACTION_ERROR_RESPONSE"; txId: string; patch: ServerPatch; error: unknown }

  // --- Revalidation ---
  | { type: "REVALIDATE_DONE"; txId: string; patch: ServerPatch }

  // --- Streaming ---
  | { type: "STREAM_START"; txId: string }
  | { type: "STREAM_END"; txId: string }

  // --- HMR ---
  | { type: "HMR_UPDATE" }
  | { type: "SEGMENTS_MISSING"; txId: string; missing: string[] }

  // --- Handles ---
  | { type: "HANDLES_UPDATE"; txId: string; handles: HandleData; matched?: string[] }

  // --- Cross-tab ---
  | { type: "CROSS_TAB_INVALIDATION"; path: string; segmentIds: string[] }

  // --- Cache control ---
  | { type: "CACHE_CLEAR_REQUESTED" }

  // --- Lifecycle ---
  | { type: "TX_ABORT_REQUESTED"; txId: string }
  | { type: "NETWORK_ERROR"; txId: string; error: Error }
  | { type: "VERSION_MISMATCH"; reloadUrl: string };
```

```ts
interface NavOptions {
  replace?: boolean;
  scroll?: boolean;
  skipLoadingState?: boolean;
  interceptSourceUrl?: string;
}
```

Note: events do NOT carry `epoch`. The transaction already captured its epoch at creation. Response events only carry `txId` -- the reducer looks up the transaction to find epoch, blueprint, and all other context. This eliminates the class of bugs where epoch is passed incorrectly.

### 6. Complete Command Catalog

Commands are true side effects only. No cache ops (those are state mutations). No transaction phase changes (those are state mutations).

```ts
type RuntimeCommand =
  // --- Network ---
  | { kind: "FETCH"; payload: FetchCommand }
  | { kind: "ABORT_FETCH"; payload: { txId: string } }

  // --- Rendering ---
  | { kind: "RENDER"; payload: RenderCommand }

  // --- History ---
  | { kind: "PUSH_HISTORY"; payload: HistoryCommand }
  | { kind: "REPLACE_HISTORY"; payload: HistoryCommand }

  // --- Cross-tab ---
  | { kind: "BROADCAST_INVALIDATION"; payload: { path: string; segmentIds: string[] } }

  // --- Scroll ---
  | { kind: "SCROLL"; payload: { behavior: "top" | "restore" | "none" } }

  // --- Hard lifecycle ---
  | { kind: "HARD_RELOAD"; payload: { url: string } };

interface FetchCommand {
  txId: string;
  url: string;
  segmentIds: string[];        // empty = full fetch
  previousUrl: string;
  mode: "nav" | "action" | "revalidate" | "hmr";
  headers?: Record<string, string>;
}

interface RenderCommand {
  snapshot: RouteSnapshot;
  forceAwait: boolean;         // true for popstate (pre-resolve loaders, no suspense)
}

interface HistoryCommand {
  url: string;
  key: string;
  state: HistoryState;
}
```

7 command kinds total. Everything else is state mutation inside the reducer. Executors are trivially thin.

### 7. Reducer

```ts
function reduce(
  state: ClientRuntimeState,
  event: RuntimeEvent
): { state: ClientRuntimeState; commands: RuntimeCommand[] }
```

Pure function. No side effects. No async. No DOM access.

The reducer follows a consistent pattern for all response events:

```
1. Look up transaction by txId
2. Call canCommit(state, tx)
3. If rejected: handle rejection (abort tx, defer, or ignore)
4. If allowed: reconcileSnapshot(tx.blueprintSnapshot, patch, tx.kind)
5. Apply result to state (update current, cache, tx phase)
6. Emit side-effect commands (RENDER, HISTORY, BROADCAST, etc.)
7. Re-derive phase
```

#### Transaction creation events:

**NAV_START:**
1. Increment `navEpoch`, bump `txCounter`.
2. Apply isolation: find active nav tx, transition to `aborted`, emit `ABORT_FETCH`.
3. Create nav Transaction:
   - `kind: "nav"`, `isolation: "exclusive"`
   - `blueprintSnapshot: state.current`
   - `navEpochAtStart: state.navEpoch`
   - `epoch: state.navEpoch`
4. Check cache for url:
   - Cache hit (fresh or stale): set `tx.optimisticSnapshot`, set `state.current` to cached snapshot (with shared-segment freshness from current), emit `RENDER` + `PUSH_HISTORY`, set `tx.phase: "fetching"`, emit `FETCH` (partial).
   - Cache miss: set `tx.phase: "fetching"`, emit `FETCH` (partial).
5. Re-derive `phase`, `pendingUrl`.

**ACTION_START:**
1. Increment `actionEpoch`, bump `txCounter`.
2. Create action Transaction:
   - `kind: "action"`, `isolation: "concurrent"`
   - `blueprintSnapshot: state.current`
   - `navEpochAtStart: state.navEpoch`
   - `epoch: state.actionEpoch`
   - `actionId`
3. Set `tx.phase: "fetching"`, emit `FETCH` (action mode).
4. Mark cache entry for current key as stale.
5. Re-derive `phase`.

**POPSTATE:**
1. Abort any active nav tx (user navigated via browser controls).
2. Look up cache by `historyKey`:
   - Cache hit: set `state.current`, emit `RENDER` (forceAwait=true) + `SCROLL` (restore).
     - If stale: create revalidate Transaction (`isolation: "background"`, `targetCacheKey: historyKey`), emit `FETCH`.
   - Cache miss: create nav Transaction, emit `FETCH` (full).
3. Re-derive `phase`.

**HMR_UPDATE:**
1. Bump `txCounter`. Create hmr Transaction (`isolation: "exclusive"`).
2. Abort previous hmr tx if any.
3. Emit `FETCH` (full, `segmentIds: []`).

#### Response events (all follow the same pattern):

**NAV_RESPONSE:**
1. Look up tx. Call `canCommit(state, tx)`.
2. If rejected (epoch stale): transition tx to `aborted`. No commands.
3. If allowed: `reconcileSnapshot(tx.optimisticSnapshot ?? tx.blueprintSnapshot, patch, "navigate")`.
   - On `ok`: set `state.current`, write to cache (fresh), transition tx to `committed`.
     - If optimistic was set: emit `REPLACE_HISTORY` (reconciliation mode) + `RENDER`.
     - Else: emit `PUSH_HISTORY` + `RENDER` + `SCROLL`.
   - On `MISSING_MATCHED_SEGMENT`: emit `FETCH` (full refetch, same txId).
   - On `STRUCTURE_VIOLATION`: dev = throw, prod = emit `FETCH` (full refetch).
4. Re-derive `phase`.

**ACTION_RESPONSE:**
1. Look up tx. Store `patch` and `returnValue` on tx. Transition tx to `received`.
2. Call `canCommit(state, tx)`:
   - `ACTION_NAVIGATED_AWAY`: don't render. Create background revalidate tx for current key. Transition action tx to `committed`.
   - `CONCURRENT_PENDING`: defer. Don't render, don't commit. Store reconciled snapshot on tx for later.
   - Allowed (last action, or sole action): `reconcileSnapshot(tx.blueprintSnapshot, patch, "action")`.
     - Reconcile ALL received sibling action tx results sequentially against current snapshot.
     - Set `state.current`. Write to cache (stale). Transition all action tx to `committed`.
     - Emit `RENDER` + `BROADCAST_INVALIDATION`.
3. Re-derive `phase`.

**ACTION_ERROR_RESPONSE:**
1. Look up tx. Call `canCommit(state, tx)`.
2. If allowed: build error snapshot (all base segments from blueprint, replace errored segment).
3. Emit `RENDER`. Transition tx to `committed`.

**REVALIDATE_DONE:**
1. Look up tx. Call `canCommit(state, tx)`.
2. `REVALIDATE_KEY_MISMATCH`: transition to `aborted`. No commands.
3. If allowed: `reconcileSnapshot(cached snapshot for targetKey, patch, "revalidate")`.
4. Update cache entry (fresh). Transition tx to `committed`. No `RENDER` (background).

#### Streaming events:

**STREAM_START:**
1. Look up tx. Set `tx.hasActiveStream = true`.
2. Re-derive `phase`.

**STREAM_END:**
1. Look up tx. Set `tx.hasActiveStream = false`.
2. Re-derive `phase`.

#### Cleanup and lifecycle events:

**TX_ABORT_REQUESTED:**
1. Look up tx. Transition to `aborted`.
2. Set `tx.hasActiveStream = false`.
3. Emit `ABORT_FETCH`.
4. Re-derive `phase`.

**SEGMENTS_MISSING:**
1. Look up tx. If action: no-op (actions tolerate partial). If nav/hmr: emit `FETCH` (full refetch).

**CROSS_TAB_INVALIDATION:**
1. Find cache entries with shared segments. Mark stale.
2. If current snapshot shares segments and `phase === "idle"`: create background revalidate tx, emit `FETCH`.

**VERSION_MISMATCH:**
1. Emit `HARD_RELOAD`.

**NETWORK_ERROR:**
1. Look up tx. Transition to `failed`. Set `tx.hasActiveStream = false`.
2. Set `state.networkError`.
3. Emit `RENDER` (error boundary).
4. Re-derive `phase`.

#### Transaction cleanup:

Transactions in terminal phases (`committed`, `aborted`, `failed`) are garbage-collected from the map after phase derivation. This prevents unbounded growth. The reducer prunes terminal transactions at the end of every reduce step:

```ts
function pruneTerminalTransactions(txs: Map<string, Transaction>): Map<string, Transaction> {
  // Keep committed/aborted/failed tx for one reduce cycle (for logging), then remove.
  // In practice: remove any tx that was terminal BEFORE this reduce step.
}
```

### 8. Reconcile Function

```ts
function reconcileSnapshot(
  base: RouteSnapshot,
  patch: ServerPatch,
  mode: "navigate" | "action" | "revalidate"
):
  | { ok: true; snapshot: RouteSnapshot }
  | { ok: false; reason: ReconcileFailure; details: string }

type ReconcileFailure =
  | "MISSING_MATCHED_SEGMENT"    // server matched ID not found in base or patch
  | "STRUCTURE_VIOLATION"        // action mode: retained node changed tree-shaping property
  | "REQUIRES_FULL_REFETCH";    // unrecoverable inconsistency
```

Single implementation. The `mode` parameter controls which preservation rules apply:

**All modes:**
1. For each `matchedId` in `patch.matched`:
   - If in `patch.diff`: use server segment.
   - Else: copy from `base` snapshot.
2. Merge partial loaders by loader ID, preserving base loader order.
3. Insert diff segments not in `matched` (loader segments from consolidation).
4. Validate: every `matchedId` must be present in result. If not: `MISSING_MATCHED_SEGMENT`.
5. Compute `StructuralSignature` for each segment.
6. Build `segmentIndex`, separate `interceptSegments` from main segments.
7. Copy `slots`, `handleData`, `interceptSourceUrl` from patch (or base if not in patch).

**Mode = "navigate" additional rules:**
8. For retained segments (not in diff): preserve `loading` from base if server differs. This prevents SSR-to-client `loading` category shift.
9. For retained segments: preserve `component` if server returns `null` (layout outlet chain).

**Mode = "action" additional rules (blueprint enforcement):**
8. For retained segments (not in diff): `loadingCategory` MUST match base. If server differs, use base value. Violation in dev throws.
9. For retained segments: `hasMountPath` MUST match base. If server differs, use base value.
10. For retained segments: `hasComponent` -- if server returns `null`, keep base component.
11. Partial loader payloads merge by loader ID, preserving base loader order exactly.
12. `interceptSegments` from base are preserved if not in diff.
13. Empty diff = strict no-op on tree shape (return base with updated metadata only).

**Mode = "revalidate" additional rules:**
8. Same structural preservation as "navigate".
9. Only updates cache, never triggers remount.

### 9. Command Execution Loop

```ts
async function executeCommands(
  commands: RuntimeCommand[],
  ctx: ExecutorContext,
  dispatch: (event: RuntimeEvent) => void
): Promise<void> {
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "FETCH":
        // create AbortController, register by txId
        // call client.fetchPartial()
        // on response: dispatch NAV_RESPONSE / ACTION_RESPONSE / REVALIDATE_DONE
        // on network error: dispatch NETWORK_ERROR
        // on missing segments: dispatch SEGMENTS_MISSING
        // on version mismatch header: dispatch VERSION_MISMATCH
        break;
      case "ABORT_FETCH":
        // call AbortController.abort() for txId
        break;
      case "RENDER":
        // call commitSegments(cmd.payload.snapshot, cmd.payload.forceAwait)
        break;
      case "PUSH_HISTORY":
        // call window.history.pushState()
        break;
      case "REPLACE_HISTORY":
        // call window.history.replaceState()
        break;
      case "BROADCAST_INVALIDATION":
        // post to BroadcastChannel
        break;
      case "SCROLL":
        // scrollTo / restoreScroll / noop
        break;
      case "HARD_RELOAD":
        // window.location.href = url
        break;
    }
  }
}
```

**Contract:** Executors contain ZERO conditional logic. No `if` statements that decide behavior. They translate commands to browser API calls and dispatch response events back to the reducer. Any decision in an executor is a bug -- move it to the reducer.

**Async commands** (FETCH): The executor starts the async operation and dispatches events when results arrive. The reducer never awaits.

**Batching:** If multiple `RENDER` commands are emitted in one reduce step, only the last one executes.

### 10. Cache Model

Cache is state inside the reducer. No cache commands.

```ts
// Key derivation (centralized, one place)
function cacheKey(url: string, interceptSourceUrl?: string | null): string {
  const parsed = new URL(url);
  const base = parsed.pathname + parsed.search;  // hash excluded
  return interceptSourceUrl ? base + ":intercept" : base;
}
```

**Rules (all enforced by reducer state mutations):**
1. Max `cacheMaxSize` entries (default 20). LRU eviction on write, never evicts `current` key.
2. HandleData is deep-cloned on cache write (prevents reference sharing across snapshots).
3. Shared-segment freshness: when `NAV_START` finds a cache hit, the reducer merges segments from `state.current` that share IDs with the cached snapshot (mounted layouts have fresher data).
4. Stale entries trigger background revalidation on popstate.
5. Actions mark current key stale at `ACTION_START`.

### 11. Rendering Model

Rendering consumes a `RouteSnapshot` and produces input for `segment-system.tsx`:

```ts
interface RenderPlan {
  segments: ResolvedSegment[];
  interceptSegments: ResolvedSegment[];
  options: {
    forceAwait: boolean;      // true on popstate: pre-resolve loaders
    scrollBehavior: "top" | "restore" | "none";
  };
}
```

`segment-system.tsx` receives clean, pre-reconciled input. It does not perform merge logic or structural decisions. The `loading` -> tree depth mapping lives in `segment-system.tsx` but the invariant that `loading` never changes for retained nodes is enforced by `reconcileSnapshot`, upstream of rendering.

### 12. Server Patch Model

No protocol changes. Adapt existing response metadata:

```ts
interface ServerPatch {
  isPartial: boolean;
  matched: string[];
  diff: string[];
  segments: ResolvedSegment[];
  slots?: Record<string, SlotState>;
  handles?: AsyncGenerator<HandleData>;
  cachedHandleData?: HandleData;
  isError?: boolean;
}
```

Adaptation from RSC payload to `ServerPatch` happens in the FETCH executor. The reducer never sees raw RSC payloads.

### 13. Runtime Store (Reactive State Container)

The store is the public interface between the runtime and React. It replaces both `NavigationStore` and `EventController` with a single reactive container backed by `ClientRuntimeState`.

#### Store interface

```ts
interface RuntimeStore {
  // Core dispatch (called by executors and event wiring)
  dispatch(event: RuntimeEvent): void;

  // State access
  getState(): ClientRuntimeState;

  // Subscriptions (all debounced, all support selectors)
  subscribe(listener: () => void): () => void;
  subscribeToAction(actionId: string, listener: (state: DerivedActionState) => void): () => void;
  subscribeToHandles(listener: (state: HandleState) => void): () => void;

  // Imperative (used by NavigationProvider for tree re-renders)
  onRender(callback: (plan: RenderPlan) => void): () => void;
}
```

`dispatch()` calls `reduce()`, applies state, executes commands, and notifies subscribers. This is the single entry point for all events.

#### Per-action state derivation (for `useAction`)

The current system tracks per-action state (`state`, `payload`, `error`, `result`) in the event controller with a settling delay. In the new runtime, this is derived from transactions:

```ts
interface DerivedActionState {
  state: "idle" | "loading" | "streaming";
  actionId: string | null;
  payload: unknown[] | null;
  error: unknown | null;
  result: unknown | null;
}

function deriveActionState(
  transactions: Map<string, Transaction>,
  actionId: string
): DerivedActionState {
  // Find most recent non-terminal action tx matching actionId.
  // actionId matching: exact match on full ID ("hash#name"), or suffix match on name only.
  // Phase mapping:
  //   tx.phase = "created" | "fetching"  -> state = "loading"
  //   tx.phase = "streaming"             -> state = "streaming"
  //   tx.phase = "received"              -> state = "loading" (still processing)
  //   tx.phase = "committed"             -> state = "idle", result = tx.resultReturnValue
  //   tx.phase = "failed"                -> state = "idle", error = tx.resultError
  //   no matching tx                     -> state = "idle"
  //
  // For result/error: check committed/failed tx even after pruning (keep last
  // committed action tx per actionId for one extra cycle so useAction can read result).
}
```

This replaces the `TrackedActionState` in the current event controller. The transaction already stores `actionId`, phase, `resultReturnValue`, and `resultError`. No separate tracking needed.

**Settling behavior:** Currently, completed actions stay in "settling" phase for 100ms before removal. In the new system, committed action tx are kept in the transaction map for one extra reduce cycle (same as other terminal tx pruning). The `useAction` hook reads result/error from committed tx before they're pruned. If the hook needs to preserve result across pruning, it copies to local React state via `useSyncExternalStore`.

#### Segment state derivation (for partial fetch and BroadcastChannel)

The current `SegmentState` (`path`, `currentUrl`, `currentSegmentIds`) is derived from the snapshot:

```ts
function deriveSegmentState(current: RouteSnapshot): SegmentState {
  return {
    path: new URL(current.url).pathname,
    currentUrl: current.url,
    currentSegmentIds: current.matched,  // segment IDs for partial fetch
  };
}
```

No separate tracking. Bridges that need segment IDs for fetch requests read `state.current.matched`.

#### Handle data updates

Handle data flows through events:

```ts
// HANDLES_UPDATE event (dispatched by executor when async handle generators yield)
| { type: "HANDLES_UPDATE"; txId: string; handles: HandleData; matched?: string[] }
```

The reducer updates `state.handleState`:
- `isPartial` (inferred from tx kind): merge new data, remove segments no longer in `matched`.
- Full update: replace entirely.

`useHandle` subscribes via `store.subscribeToHandles()` and derives its value from `state.handleState`.

#### Subscription and notification strategy

```ts
// Internal notification implementation
class RuntimeStore {
  private stateListeners = new Set<() => void>();
  private actionListeners = new Map<string, Set<(s: DerivedActionState) => void>>();
  private handleListeners = new Set<(s: HandleState) => void>();
  private renderListeners = new Set<(plan: RenderPlan) => void>();

  dispatch(event: RuntimeEvent): void {
    const prev = this.state;
    const { state: next, commands } = reduce(this.state, event);
    this.state = next;

    // Determine what changed
    const snapshotChanged = next.current !== prev.current;
    const phaseChanged = next.phase !== prev.phase || next.pendingUrl !== prev.pendingUrl;
    const handleChanged = next.handleState !== prev.handleState;
    const txChanged = next.transactions !== prev.transactions;

    // Execute side-effect commands (may dispatch further events)
    executeCommands(commands, this.ctx, (e) => this.dispatch(e));

    // Notify subscribers (debounced)
    if (phaseChanged || snapshotChanged || txChanged) {
      this.notifyStateDebounced();        // 0ms microtask batch
    }
    if (txChanged) {
      this.notifyActionDebounced();       // per-actionId, 20ms debounce
    }
    if (handleChanged) {
      this.notifyHandleDebounced();       // 0ms microtask batch
    }
  }
}
```

**Debouncing matches current behavior:**
- State listeners: microtask batched (0ms). Multiple synchronous dispatches produce one notification.
- Action listeners: 20ms debounce per actionId. Prevents rapid re-renders during streaming.
- Handle listeners: microtask batched.
- Render listeners: synchronous (RENDER command triggers immediate tree update via `onRender`).

#### Cross-tab cache invalidation

The current `BroadcastChannel` logic moves to the executor (BROADCAST_INVALIDATION command) and an event listener wired in `runtime.ts`:

```ts
// In runtime.ts initialization
const channel = new BroadcastChannel("rango-cache");
channel.onmessage = (event) => {
  store.dispatch({
    type: "CROSS_TAB_INVALIDATION",
    path: event.data.path,
    segmentIds: event.data.segmentIds,
  });
};
```

The reducer decides what to do (mark stale, trigger background revalidation). The store just dispatches the event.

#### `useClientCache` hook

Exposes imperative cache control:

```ts
function useClientCache(): { clear: () => void } {
  const store = useRuntimeStore();
  return {
    clear: () => {
      // Dispatch event that clears cache + broadcasts
      store.dispatch({ type: "CACHE_CLEAR_REQUESTED" });
    },
  };
}
```

Requires adding `CACHE_CLEAR_REQUESTED` to the event catalog (reducer clears all cache entries, emits `BROADCAST_INVALIDATION`).

#### What the store replaces

| Current module | Store equivalent |
|---|---|
| `NavigationStore.getState()` | `derivePhase(state.transactions)` + `state.pendingUrl` |
| `NavigationStore.getSegmentState()` | `deriveSegmentState(state.current)` |
| `NavigationStore.cacheSegmentsForHistory()` | Reducer state mutation on `state.cache` |
| `NavigationStore.markCacheAsStale()` | Reducer state mutation on cache entries |
| `NavigationStore.getInterceptSourceUrl()` | `state.interceptSourceUrl` |
| `NavigationStore.getActionState(id)` | `deriveActionState(state.transactions, id)` |
| `NavigationStore.onUpdate()` | `store.onRender()` |
| `NavigationStore.broadcastCacheInvalidation()` | `BROADCAST_INVALIDATION` command |
| `EventController.startNavigation()` | `store.dispatch({ type: "NAV_START", ... })` |
| `EventController.startAction()` | `store.dispatch({ type: "ACTION_START", ... })` |
| `EventController.getState()` | Pure derivation from `state.transactions` |
| `EventController.getActionState(id)` | `deriveActionState(state.transactions, id)` |
| `EventController.getHandleState()` | `state.handleState` |
| `EventController.subscribe()` | `store.subscribe()` |
| `EventController.subscribeToAction()` | `store.subscribeToAction()` |
| `EventController.subscribeToHandles()` | `store.subscribeToHandles()` |

Both `NavigationStore` and `EventController` are deleted in Phase 3. The store is the sole reactive container.

---

## Invariants

Enforced centrally in `canCommit`, `reconcileSnapshot`, and the reducer. Each invariant has corresponding unit tests.

**Transaction invariants:**
1. A tx in terminal phase (`committed`, `aborted`, `failed`) never transitions again.
2. `canCommit()` is the sole gate for all response processing. No inline epoch checks elsewhere.
3. Exclusive isolation aborts all active tx of the same kind before the new tx begins fetching.
4. Concurrent (action) tx only commit together when ALL siblings reach `received` phase.
5. Background tx cannot affect `phase` derivation.
6. Terminal tx with `hasActiveStream=true` is impossible (cleanup sets false on abort/fail).
7. A tx's `blueprintSnapshot` is immutable after creation.

**Reconcile invariants:**
8. `matched` IDs are unique and every ID is present in the result snapshot.
9. Retained nodes (not in diff) preserve `StructuralSignature` unless full refetch.
10. Loader merge preserves loader order by loader ID.
11. Intercept segments are explicit snapshot state, not inferred from ID patterns at render time.
12. Action-mode retained nodes cannot change `loadingCategory` or `hasMountPath`.

**Cache invariants:**
13. LRU eviction never evicts `current` snapshot key.
14. HMR full-refetch replaces entire snapshot (no partial merge with stale modules).

---

## Testing Strategy

### Layer 0: Transaction Lifecycle Unit Tests

Pure tests for `canCommit()` and transaction phase transitions. No reducer, no reconcile.

**0.1 canCommit() exhaustive matrix:**
1. Aborted tx -> rejected (TX_ABORTED).
2. Failed tx -> rejected (TX_FAILED).
3. Nav tx with epoch < navEpoch -> rejected (NAV_EPOCH_STALE).
4. Revalidate tx with targetKey != current.key -> rejected (REVALIDATE_KEY_MISMATCH).
5. Action tx with navEpochAtStart != navEpoch -> rejected (ACTION_NAVIGATED_AWAY).
6. Action tx with sibling still fetching -> rejected (CONCURRENT_PENDING).
7. Action tx with all siblings received -> allowed.
8. Sole action tx -> allowed.
9. Nav tx with matching epoch -> allowed.
10. Background revalidate tx with matching key -> allowed.

**0.2 Phase derivation:**
1. No active tx -> "idle".
2. Nav tx in "fetching" -> "loading".
3. Action tx in "streaming" -> "streaming".
4. Background revalidate tx in "fetching" alone -> "idle" (background doesn't affect phase).
5. Mix of background and nav tx -> phase follows nav tx.

**0.3 Isolation rules:**
1. Creating exclusive nav tx aborts active nav tx.
2. Creating concurrent action tx does not abort active action tx.
3. Creating exclusive hmr tx aborts active hmr tx.
4. Creating nav tx does not abort active action tx.

### Layer 1: Reconcile Unit Tests

Pure `reconcileSnapshot()` tests. No transactions, no runtime state.

**1.1 Core merge:**
1. Server diff segments replace base segments at matching IDs.
2. Non-diff matched IDs copied from base.
3. Missing matched ID returns `MISSING_MATCHED_SEGMENT` error.
4. Loader merge preserves base loader order when server sends partial loaders.
5. Diff segments not in matched (loader segments) are inserted after parent.
6. Output is deterministic regardless of input segment array order.

**1.2 Navigate mode:**
1. Retained segment preserves cached `loading` when server differs.
2. Retained layout preserves `component` when server returns `null`.
3. Intercept segments separated into `interceptSegments`.
4. Slot state merged from patch.

**1.3 Action mode (blueprint enforcement):**
1. Retained node `loadingCategory` immutable (server `loading=<skeleton>` ignored for `loading=false` base).
2. Retained node `hasMountPath` immutable.
3. Retained layout `component: null` from server keeps base component.
4. Partial loader response merges by loader ID preserving base order.
5. Diff segment insertion does not reorder unchanged ancestors.
6. Intercept slot action update keeps background blueprint segments.
7. Empty diff = strict no-op on tree shape (segments identical to base).
8. Structure violation: dev throws, prod returns `STRUCTURE_VIOLATION`.

**1.4 Revalidate mode:**
1. Same structural preservation as navigate mode.
2. Fresh segments replace stale base segments.

**1.5 Error snapshots:**
1. Action error response: all base segments preserved except errored one.
2. Navigation error: error node replaces matched segments.

### Layer 2: Reducer Unit Tests

Pure `reduce(state, event)` tests. Assert `nextState` (including transaction map and cache) and `commands`. No DOM, no network.

**2.1 Navigation lifecycle:**
1. `NAV_START` with cache hit: creates nav tx with optimisticSnapshot, emits `RENDER` + `PUSH_HISTORY` + `FETCH`.
2. `NAV_START` with cache miss: creates nav tx (no optimistic), emits `FETCH` only. Phase = "loading".
3. `NAV_START` with stale cache: creates nav tx, renders optimistic, emits `FETCH`.
4. `NAV_RESPONSE` after optimistic: reconciles against `tx.optimisticSnapshot`, emits `REPLACE_HISTORY` + `RENDER`. tx -> committed.
5. `NAV_RESPONSE` without optimistic: reconciles against `tx.blueprintSnapshot`, emits `PUSH_HISTORY` + `RENDER`. tx -> committed.
6. `NAV_RESPONSE` for aborted tx: ignored (canCommit rejects).

**2.2 Navigation concurrency (isolation: exclusive):**
1. `NAV_START` B: tx A transitions to `aborted`, emits `ABORT_FETCH` for A. tx B created.
2. `NAV_RESPONSE` for aborted tx A: canCommit rejects, no state change.
3. Rapid `NAV_START` x3: only tx C survives, A and B aborted.
4. `NAV_START` does NOT abort active action tx (different kind).

**2.3 Popstate:**
1. `POPSTATE` with fresh cache: sets current, emits `RENDER` (forceAwait=true) + `SCROLL` (restore). No tx created.
2. `POPSTATE` with stale cache: sets current, emits `RENDER` + `SCROLL`. Creates background revalidate tx, emits `FETCH`.
3. `POPSTATE` with no cache: creates nav tx, emits `FETCH` (full).
4. `REVALIDATE_DONE` after key changed: canCommit rejects (REVALIDATE_KEY_MISMATCH). tx -> aborted.
5. `REVALIDATE_DONE` for matching key: updates cache (fresh). No `RENDER`. tx -> committed.

**2.4 Actions (isolation: concurrent):**
1. `ACTION_START`: creates action tx, marks cache stale, emits `FETCH`.
2. `ACTION_RESPONSE` (sole action): canCommit allows, reconciles, emits `RENDER` + `BROADCAST_INVALIDATION`. tx -> committed. Cache updated (stale).
3. `ACTION_RESPONSE` (concurrent, not last): canCommit returns CONCURRENT_PENDING. tx -> received. Patch stored. No render.
4. `ACTION_RESPONSE` (concurrent, last): canCommit allows. Reconciles all received patches sequentially. Emits `RENDER` + `BROADCAST_INVALIDATION`. All action tx -> committed.
5. `ACTION_RESPONSE` after nav away: canCommit returns ACTION_NAVIGATED_AWAY. Creates background revalidate tx instead.
6. `ACTION_ERROR_RESPONSE`: builds error snapshot from blueprint, emits `RENDER`. tx -> committed.
7. Concurrent actions A/B complete out of order: both patches applied cleanly.

**2.5 Streaming lifecycle:**
1. `STREAM_START`: sets `tx.hasActiveStream = true`. Phase re-derived.
2. `STREAM_END`: sets `tx.hasActiveStream = false`. Phase re-derived.
3. `TX_ABORT_REQUESTED` for tx with active stream: `hasActiveStream = false`, tx -> aborted. Phase = "idle".
4. All streams end + no fetching tx -> phase = "idle".

**2.6 HMR:**
1. `HMR_UPDATE`: creates hmr tx (exclusive), emits `FETCH` (full, empty segmentIds).
2. `SEGMENTS_MISSING` during nav: emits `FETCH` (full refetch, same txId).
3. `SEGMENTS_MISSING` during action: no-op.

**2.7 Cross-tab:**
1. `CROSS_TAB_INVALIDATION` with shared segments: marks cache entries stale.
2. `CROSS_TAB_INVALIDATION` while idle with shared current segments: creates background revalidate tx, emits `FETCH`.
3. `CROSS_TAB_INVALIDATION` with no shared segments: no-op.

**2.8 Error and lifecycle:**
1. `NETWORK_ERROR`: sets `networkError`, emits `RENDER` (error boundary), tx -> failed, stream cleaned up.
2. `VERSION_MISMATCH`: emits `HARD_RELOAD`.
3. `TX_ABORT_REQUESTED`: tx -> aborted, stream cleaned up, `ABORT_FETCH` emitted. Phase re-derived.

**2.9 Cache behavior (state mutations):**
1. Nav commit: writes cache entry (fresh) for committed URL.
2. Action start: marks current key stale.
3. Action commit: writes cache entry (stale).
4. Cache at max capacity: evicts oldest non-current entry.
5. Cache never evicts `current` key.
6. Shared-segment freshness: `NAV_START` cache hit uses segments from `current` for shared IDs.

**2.10 Handle data:**
1. `HANDLES_UPDATE` (partial): merges new handle data, removes segments not in `matched`.
2. `HANDLES_UPDATE` (full): replaces `handleState` entirely.
3. Handle data preserved across action reconcile (blueprint enforcement).

**2.11 Intercept context:**
1. `NAV_START` with `interceptSourceUrl`: sets `state.interceptSourceUrl`.
2. Leaving intercept (same URL, no intercept): clears `state.interceptSourceUrl`.
3. Action FETCH includes `interceptSourceUrl` header when set.

**2.12 Transaction cleanup:**
1. Terminal tx are pruned from map after reduce step.
2. Pruning does not affect active tx.
3. After pruning: `transactions.size` equals number of active tx.
4. Committed action tx are retained one extra cycle for `useAction` result reads.

**2.13 Cache clear:**
1. `CACHE_CLEAR_REQUESTED`: clears all cache entries, emits `BROADCAST_INVALIDATION`.

### Layer 2.5: Store Derivation Unit Tests

Pure tests for derivation functions. No reducer, no DOM.

**2.5.1 deriveActionState:**
1. No matching tx -> idle state, null result.
2. Action tx in "fetching" -> state = "loading".
3. Action tx in "streaming" -> state = "streaming".
4. Action tx in "received" (batch pending) -> state = "loading".
5. Action tx "committed" -> state = "idle", result populated.
6. Action tx "failed" -> state = "idle", error populated.
7. Multiple tx for same actionId: most recent non-terminal wins.
8. Suffix match: "addToCart" matches "hash#addToCart".
9. Exact match: "hash#addToCart" only matches full ID.
10. Committed tx pruned but result preserved for one cycle.

**2.5.2 deriveSegmentState:**
1. Derives path, currentUrl, currentSegmentIds from `state.current`.
2. `currentSegmentIds` matches `state.current.matched`.

**2.5.3 Notification batching (integration):**
1. Multiple synchronous dispatches produce one state notification.
2. Action notifications debounced at 20ms per actionId.
3. RENDER command triggers synchronous render callback (not debounced).

### Layer 3: Sequence Tests

Event sequences through the reducer verifying multi-step transaction lifecycles:

1. `NAV_START -> POPSTATE -> NAV_RESPONSE` -- nav tx aborted by popstate, response rejected.
2. `ACTION_START x2 -> ACTION_RESPONSE(B) -> ACTION_RESPONSE(A)` -- both reach received, last triggers batch commit.
3. `POPSTATE(stale) -> REVALIDATE_DONE(wrong key)` -- revalidate tx rejected.
4. `NAV_START(cached) -> NAV_RESPONSE` -- optimistic render then reconciliation.
5. `ACTION_START -> NAV_START -> ACTION_RESPONSE` -- action tx detects nav-away, creates background revalidate.
6. `HMR_UPDATE -> SEGMENTS_MISSING -> NAV_RESPONSE(full)` -- HMR recovery chain.
7. `NAV_START -> STREAM_START -> TX_ABORT_REQUESTED -> (verify hasActiveStream=false, phase=idle)`.
8. `NAV_START(cached) -> NAV_RESPONSE(empty diff)` -- no-op reconcile, optimistic snapshot preserved.
9. `ACTION_START -> STREAM_START -> NETWORK_ERROR -> (verify tx=failed, stream cleaned, error rendered)`.
10. `NAV_START x3 -> NAV_RESPONSE(tx1) -> NAV_RESPONSE(tx2) -> NAV_RESPONSE(tx3)` -- only tx3 commits.

### Layer 4: Adapter Integration Tests

Thin tests verifying executors are correctly wired:

1. `FETCH` command creates AbortController, sends correct headers, dispatches response event.
2. `RENDER` command calls `commitSegments` with correct snapshot and forceAwait.
3. `PUSH_HISTORY` / `REPLACE_HISTORY` call correct `window.history` API.
4. `ABORT_FETCH` calls `AbortController.abort()`.
5. `BROADCAST_INVALIDATION` posts to `BroadcastChannel`.
6. `HARD_RELOAD` sets `window.location.href`.

These are the only tests that need a browser environment. They test wiring, not behavior.

### Layer 5: E2E Parity Tests

Before switching: existing e2e tests against the new runtime confirm no regressions. Verification, not primary suite.

---

## Migration Plan

### Phase 1: Build and Test New Runtime

Build as standalone module alongside existing code. Does not touch existing bridges.

**New modules:**
```
packages/rangojs-router/src/browser/runtime/
  types.ts              -- Transaction, RouteSnapshot, ClientRuntimeState, events, commands
  transaction.ts        -- canCommit(), derivePhase(), applyIsolation(), pruneTerminal()
  signatures.ts         -- computeSignature(), compareSignatures()
  reconcile.ts          -- reconcileSnapshot()
  reducer.ts            -- reduce()
  cache.ts              -- cacheKey(), LRU eviction, shared-segment freshness (pure functions)
  derive.ts             -- deriveActionState(), deriveSegmentState(), deriveHandleState()
  store.ts              -- RuntimeStore class (dispatch, subscribe, notification batching)
  snapshot-adapter.ts   -- converts current ResolvedSegment[] + metadata to RouteSnapshot
```

**New test files:**
```
packages/rangojs-router/src/browser/runtime/__tests__/
  transaction.test.ts   -- Layer 0 tests (canCommit, phase derivation, isolation)
  reconcile.test.ts     -- Layer 1 tests
  reducer.test.ts       -- Layer 2 tests
  derive.test.ts        -- Layer 2.5 tests (action state, segment state derivations)
  sequences.test.ts     -- Layer 3 tests
```

**Deliverable:** Full unit test suite passes. Every behavior from Layers 0-3 is covered. Zero dependencies on browser APIs or React.

### Phase 2: Wire Executors and Shadow Mode

Build command executor layer. Run new runtime in shadow mode alongside old bridges.

**New modules:**
```
packages/rangojs-router/src/browser/runtime/
  executor.ts           -- executeCommands() switch statement
  runtime.ts            -- wires event listeners (popstate, BroadcastChannel, HMR), creates store
```

**Shadow mode:** In dev, both old and new systems process the same inputs. Assert that new runtime's `state.current` snapshot matches segments committed by old system. Log divergences with full event trace.

**Deliverable:** Shadow mode runs without divergence across existing e2e suite.

### Phase 3: Switch Over

Replace old bridges with new runtime.

**Delete:**
- `navigation-bridge.ts` -- behaviors now NAV_START/NAV_RESPONSE events + FETCH/HISTORY/RENDER commands.
- `server-action-bridge.ts` -- behaviors now ACTION_START/ACTION_RESPONSE events + FETCH/RENDER commands.
- `partial-update.ts` -- merge logic now in `reconcile.ts`.
- `event-controller.ts` -- lifecycle state now derived from transactions in `ClientRuntimeState`.
- `navigation-store.ts` -- cache, segment state, action state, cross-tab sync all in `RuntimeStore` + `ClientRuntimeState`.
- `segment-structure-assert.ts` -- invariants now enforced by `reconcileSnapshot()` signature checks.
- `merge-segment-loaders.ts` -- loader merge now in `reconcile.ts`.

**Deliverable:** All existing e2e tests pass. All new unit tests pass. Old modules deleted.

### Phase 4: Simplify Rendering

With reconcile guaranteeing structural stability:
- Remove defensive checks in `segment-system.tsx` that duplicate reconcile invariants.
- Remove intercept ID pattern matching (intercept segments explicit in snapshot).
- `renderSegments` receives `RenderPlan` instead of raw segments + options.

**Deliverable:** Cleaner `segment-system.tsx` with fewer branches.

---

## Risks and Mitigations

1. **Risk:** Shadow mode divergence reveals behavior differences.
   **Mitigation:** Each divergence is a bug to fix before Phase 3. Shadow mode is specifically designed to catch these.

2. **Risk:** Executor wiring introduces bugs not caught by unit tests.
   **Mitigation:** Layer 4 adapter tests verify wiring. Shadow mode verifies end-to-end.

3. **Risk:** Performance regression from transaction/snapshot creation overhead.
   **Mitigation:** Transaction is a plain object (~15 fields). RouteSnapshot uses flat arrays. Signatures map computed once per reconcile. Profile against existing metrics.

4. **Risk:** New runtime misses an edge case in old bridges.
   **Mitigation:** Phase 1 unit tests written by examining every branch in existing bridge code. Shadow mode catches runtime divergence. Old code not deleted until Phase 3 verification passes.

5. **Risk:** Transaction map grows unbounded.
   **Mitigation:** Terminal tx pruned every reduce step. Active tx count is bounded by realistic concurrency (typically 1 nav + 0-3 actions + 0-1 revalidate).

---

## Acceptance Criteria

1. **canCommit coverage:** Every row in the Layer 0 matrix (0.1) has a passing unit test.
2. **Reconcile coverage:** Every scenario in Layer 1 (1.1-1.5) has a passing unit test.
3. **Reducer coverage:** Every behavior in Layer 2 (2.1-2.13) has a passing unit test.
4. **Derivation coverage:** Every derivation in Layer 2.5 (2.5.1-2.5.3) has a passing unit test.
5. **Sequence coverage:** All 10 sequence tests in Layer 3 pass.
6. **No structural remounts:** Action and navigation reconcile preserve `StructuralSignature` for retained nodes.
7. **No stuck loading:** Abort/fail always sets `hasActiveStream = false`. Phase derives to "idle" when appropriate.
8. **Transaction isolation:** Exclusive tx aborts siblings. Concurrent tx batch-commit.
9. **Hook parity:** `useNavigation()`, `useAction()`, `useHandle()`, `useClientCache()` produce identical values to current system.
10. **E2E parity:** All existing e2e tests pass against the new runtime.
11. **Old code deleted:** All 7 old modules removed (`navigation-bridge`, `server-action-bridge`, `partial-update`, `event-controller`, `navigation-store`, `segment-structure-assert`, `merge-segment-loaders`).
12. **Single reconcile:** One `reconcileSnapshot()` handles navigation, actions, and revalidation.
13. **Single store:** One `RuntimeStore` replaces both `NavigationStore` and `EventController`.
14. **Adapter contract:** Executors contain zero conditional logic.
15. **Cache is state:** No cache commands. All cache ops are reducer state mutations.

---

## Implementation Notes

**Module dependency graph:**

```
types.ts            -- zero dependencies (pure type definitions)
transaction.ts      -- depends on types.ts only
signatures.ts       -- depends on types.ts only
cache.ts            -- depends on types.ts only
derive.ts           -- depends on types.ts only
reconcile.ts        -- depends on types.ts, signatures.ts
reducer.ts          -- depends on types.ts, transaction.ts, reconcile.ts, cache.ts
snapshot-adapter.ts -- depends on types.ts, signatures.ts (bridges old format)
store.ts            -- depends on types.ts, reducer.ts, derive.ts (+ subscriber notification)
executor.ts         -- depends on types.ts (+ browser APIs)
runtime.ts          -- depends on store.ts, executor.ts (composition root + event wiring)
```

Everything except `executor.ts`, `store.ts` (notification layer), and `runtime.ts` is pure. The store's dispatch+reduce is pure; only its notification debouncing touches scheduling APIs (`queueMicrotask`, `setTimeout`).

**Dev tooling:**
- Reducer event log: in dev mode, `runtime.ts` records `[event, prevState, nextState, commands]` tuples to a ring buffer. Inspectable via `window.__RANGO_RUNTIME_LOG__`.
- Transaction inspector: `window.__RANGO_TRANSACTIONS__` shows all active transactions with phase, kind, and age.
- Shadow mode assertion: logs divergence with full event trace for reproduction.

**Hook derivations from RuntimeStore:**

```ts
// useNavigation() -- subscribes via store.subscribe()
function useNavigation(): NavigationValue {
  const store = useRuntimeStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return {
    state: state.phase === "idle" ? "idle" : "loading",
    isStreaming: state.phase === "streaming",
    location: new URL(state.current.url),
    pendingUrl: state.pendingUrl,
    navigate: (url, opts) => store.dispatch({ type: "NAV_START", url, options: opts ?? {} }),
    refresh: () => store.dispatch({ type: "NAV_START", url: state.current.url, options: { replace: true } }),
  };
}

// useAction(actionId) -- subscribes via store.subscribeToAction()
function useAction(action: ServerActionFunction | string): DerivedActionState {
  const store = useRuntimeStore();
  const actionId = typeof action === "string" ? action : action.$$id;
  return useSyncExternalStore(
    (cb) => store.subscribeToAction(actionId, cb),
    () => deriveActionState(store.getState().transactions, actionId)
  );
}

// useHandle(handle) -- subscribes via store.subscribeToHandles()
function useHandle<T, A>(handle: Handle<T, A>): A {
  const store = useRuntimeStore();
  return useSyncExternalStore(
    (cb) => store.subscribeToHandles(cb),
    () => handle.collect(store.getState().handleState)
  );
}

// useClientCache() -- dispatches CACHE_CLEAR_REQUESTED
function useClientCache(): { clear: () => void } {
  const store = useRuntimeStore();
  return { clear: () => store.dispatch({ type: "CACHE_CLEAR_REQUESTED" }) };
}
```

All hooks use `useSyncExternalStore` with selectors for granular re-renders. No separate event-controller or navigation-store. Every hook reads from one `RuntimeStore` backed by one `ClientRuntimeState`.

**NavigationProvider simplification:**

```ts
// Current: subscribes to store.onUpdate() + processes async handle generators + manages theme
// New: subscribes to store.onRender() for tree re-renders. Handle processing is a HANDLES_UPDATE
//      event dispatched by the FETCH executor as async generators yield. Theme management unchanged.
function NavigationProvider({ store, children }) {
  const [tree, setTree] = useState(initialTree);
  useEffect(() => store.onRender((plan) => {
    setTree(renderSegments(plan));
  }), [store]);
  return <Context.Provider value={stableCtx}>{tree}</Context.Provider>;
}
```
