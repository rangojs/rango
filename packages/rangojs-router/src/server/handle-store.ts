import { findEnclosingLoaderBody, isInsideLoaderScope } from "./context.js";
import { holdsThenable } from "../router/segment-resolution/mask-nested.js";

/**
 * Handle data structure: handleName -> segmentId -> entries[]
 *
 * @example
 * ```ts
 * {
 *   "breadcrumbs": {
 *     "$root.layout": [{ label: "Home", href: "/" }],
 *     "shop.layout": [{ label: "Shop", href: "/shop" }],
 *   }
 * }
 * ```
 */
export type HandleData = Record<string, Record<string, unknown[]>>;

/**
 * Build a HandleData snapshot from a HandleStore using segment ordering.
 * Reads data directly from the store for each segment in order.
 */
export function buildHandleSnapshot(
  handleStore: HandleStore,
  segmentOrder: string[],
): HandleData {
  const data: HandleData = {};
  for (const segmentId of segmentOrder) {
    const segData = handleStore.getDataForSegment(segmentId);
    for (const handleName in segData) {
      if (!data[handleName]) data[handleName] = {};
      data[handleName][segmentId] = segData[handleName];
    }
  }
  return data;
}

function createLateHandlePushError(
  handleName: string,
  segmentId: string,
): Error {
  const error = new Error(
    `Handle "${handleName}" for segment "${segmentId}" was pushed after handle collection completed. ` +
      `This usually means an async JSX subtree suspended and later tried to push a handle during streaming. ` +
      `Push handles from the route/layout handler or during the initial synchronous JSX render instead.`,
  );
  error.name = "LateHandlePushError";
  return error;
}

/**
 * Per-slot flags, parallel to one handle/segment values array. Allocated on
 * the array's first flagged slot; positions past its length are unflagged.
 */
interface SlotTag {
  /** Pushed inside a DSL loader scope; captureHandles drops it. */
  loader?: boolean;
  /** A cached unit's replay of this loader's recorded push (pushReplayed). */
  replayOf?: string;
  /**
   * A record's copy for a loader that record does not supply the value of
   * (pushPlaceholder): it stands in until the loader's own source delivers.
   */
  placeholderOf?: string;
  /** Pushed by this loader's live run after it replaced its copies. */
  liveOf?: string;
  /**
   * The loaders around that run's body whose runs replaced copies too: their
   * next push follows this one, so a run's pushes keep their order.
   */
  under?: readonly string[];
  /** Pushed by this loader's body and kept in records (push `owner`). */
  owner?: string;
  /** A record's copy for a loader served from that record's pin (pushRestored). */
  restoredOf?: string;
  /** A restored slot a dropped settled push of its loader stood in for. */
  matched?: true;
}

// Shared by every plain DSL-loader push; tags are never mutated in place.
const LOADER_SLOT: SlotTag = Object.freeze({ loader: true });

/**
 * What a restored record is to one loader's handle pushes on this request
 * (loader-cache.ts loaderPins; docs/design/handle-push-ownership.md). Two
 * answers let the record's copies stand, two make them placeholders, and in
 * each pair one also speaks for the loader's other pushes:
 * - "pin": the request serves the loader's value from the pin stored with
 *   the record, and the record lists every settled push of that run. Its
 *   copies stand, and any other settled push of the loader is dropped.
 * - "copies": its copies stand and nothing else is known: a dependency of
 *   pinned loaders, or a pin written before captures recorded every push.
 * - "hole": the route runs the loader on this request (it registers it and
 *   the record does not pin it). Its copies are placeholders and a push made
 *   in its body is its own, with or without copies.
 * - "placeholders": its copies are placeholders and nothing else is known: a
 *   dependency the route does not register while a pin is missing (the
 *   record does not name the loader that ran it). Without copies its push
 *   counts for the loader that awaits it.
 */
export type RecordAuthority = "pin" | "copies" | "hole" | "placeholders";

function cloneHandleData(data: HandleData): HandleData {
  const clone: HandleData = {};
  for (const handleName in data) {
    clone[handleName] = {};
    for (const segmentId in data[handleName]) {
      clone[handleName][segmentId] = [...data[handleName][segmentId]];
    }
  }
  return clone;
}

/**
 * HandleStore tracks pending handler promises and stores handle data.
 *
 * Combines two responsibilities:
 * 1. Promise tracking - know when all handlers have resolved
 * 2. Data storage - collect handle data pushed by handlers
 * 3. Streaming - emit handle data via async iterator on each push
 */
export interface HandleStore {
  /**
   * Track a handler promise (non-blocking).
   * Returns the promise unchanged - just registers it for tracking.
   */
  track<T>(promise: Promise<T>): Promise<T>;

  /**
   * Signal that no more track() calls will be made.
   * settled will not resolve until seal() is called AND all tracked
   * promises have settled. Calling stream() or getData() auto-seals.
   */
  seal(): void;

  /**
   * Promise that resolves when the store is sealed AND all tracked
   * handlers have settled.
   */
  readonly settled: Promise<void>;

  /**
   * Optional error callback for late streaming-handle failures.
   * Called when push() throws LateHandlePushError (handle pushed after
   * stream completion). Allows the router to surface these errors
   * to onError and telemetry.
   */
  onError?: (error: Error) => void;

  /**
   * Track a promise on the AUXILIARY (loader) settlement lane. Aux tracking
   * keeps the store OPEN for pushes (a mid-body `ctx.handle(H)(...)` from a
   * streaming loader is legal until this lane drains) WITHOUT joining
   * `settled` — the handler barrier that rendered()-readers, the document
   * handle snapshot, and prerender/cache collection wait on. Two lanes exist
   * because loader bodies stream: joining them to `settled` would block SSR
   * markup and hydration on the slowest loader (ssr-root.tsx and
   * rsc-router.tsx both drain the document handle stream in blocking
   * positions), and would self-deadlock any loader awaiting ctx.rendered().
   */
  trackAuxiliary<T>(promise: Promise<T>): Promise<T>;

  /**
   * Promise that resolves when the store is sealed AND BOTH lanes (handler +
   * auxiliary) have drained. Late-push legality and default stream completion
   * key on this, not on `settled`.
   */
  readonly fullySettled: Promise<void>;

  /**
   * Push handle data for a specific handle and segment.
   * Multiple pushes to the same handle/segment accumulate in an array.
   * Each push triggers an emission on the stream.
   *
   * `loaderPush` overrides the push-time DSL-loader tag
   * (isInsideLoaderScope()) that getDataForSegment(id, true) excludes. The
   * PPR shell capture passes false for the bake-lane pushes its record keeps
   * (shell-capture.ts deriveShellCaptureContext), with `owner` set to the
   * pushing loader's id so the record can restore them through pushReplayed
   * (getRecordOwners).
   */
  push(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderPush?: boolean,
    owner?: string,
  ): void;

  /**
   * push() a cached unit's copy of a value `loaderId`'s body pushed
   * (handle-snapshot.ts appendHandles: a loader-cache or "use cache" HIT). If
   * that loader then runs live in this request, its first push removes every
   * copy pushed for it (replays and placeholders) and takes the first one's
   * position, and the pushes of that run follow in push order, a dependency's
   * included, so the handle output stays live without a duplicate. A push
   * counts as that loader's when it is made in its body, or in a body it
   * entered that has no copies of its own (the capture credits a dependency's
   * push under a live-lane loader to that loader). A run that ends without a
   * push leaves a replay in place, unless the loader is a hole
   * (settleLoaderRun).
   */
  pushReplayed(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderId: string,
  ): void;

  /**
   * push() a record's copy of `loaderId`'s push as a placeholder
   * (handle-snapshot.ts restoreHandles): the record does not supply that
   * loader's value on this request, so its own source decides its pushes. A
   * live run replaces it as it does a replay; a run that ends without a push
   * drops it (settleLoaderRun); a cached unit that claims the loader delivers
   * in its place (replacePlaceholders).
   */
  pushPlaceholder(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderId: string,
  ): void;

  /**
   * push() a record's copy of `loaderId`'s settled push that stands
   * (restoreHandles): the record supplies the loader's value too. From then
   * on this request drops every settled, thenable-free push the loader makes
   * (live, or replayed from a cache entry, anywhere inside its body), and
   * keeps the ones holding a thenable (holdsThenable: what the record could
   * not keep), placed among the restored copies in the loader's push order.
   */
  pushRestored(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderId: string,
  ): void;

  /**
   * What the record this request restored is to each loader (RecordAuthority;
   * CacheScope.lookupRouteDetailed sets it on a hit). A "pin" loader counts
   * as restored with or without copies. A hole is a "hole" loader or one with
   * placeholders: the walk out through enclosing loader bodies that finds the
   * loader a push counts for stops at its body, so a pinned loader never
   * takes a push made inside a hole it awaited.
   */
  setRecordAuthority(authority: (loaderId: string) => RecordAuthority): void;

  /**
   * `loaderId`'s run in this request settled (resolved or rejected), its
   * pushes made (loader-resolution.ts createLoaderExecutor). Its placeholders
   * that no push of the run replaced are dropped: the run's output decides,
   * so a loader that throws or skips its push shows none rather than the
   * record's. A hole's replays go with them. Any other loader's replays stay
   * (a dependency another entry's HIT replayed), and so do restored copies.
   */
  settleLoaderRun(loaderId: string): void;

  /**
   * A cached unit's HIT delivering the pushes it recorded for `loaderIds`,
   * the loaders it claimed (appendHandles). Their placeholders give way to
   * what `deliver` pushes for them, nothing when it pushes nothing, so the
   * page shows the pushes of the run that produced the unit's value. The
   * pushReplayed calls `deliver` makes take the removed values' place in each
   * array, in order. Without placeholders it is a plain replay.
   */
  replacePlaceholders(loaderIds: readonly string[], deliver: () => void): void;

  /**
   * Get all collected handle data after all handlers have settled.
   * Waits for `settled` (handler lane), then returns the data at that point.
   */
  getData(): Promise<HandleData>;

  /**
   * Fix the document lane at the store's current state. From then on
   * `stream("settled")` yields this state and nothing newer, and
   * `streamLate()` delivers every change made after it, whether or not it
   * beat the handler barrier. The first call wins. It must run before the
   * document stream is first read: a stream that started on the live state
   * stays on it (reported through `onError` in development).
   *
   * A PPR shell HIT calls it once its record is replayed and before a loader
   * runs (rsc-rendering.ts serveShellHit). The prelude was rendered from the
   * record's handle data (resolvedHandleStream `recordedOnly`), so that is
   * what the client must hydrate with. What the request's loaders then push,
   * replace or drop is theirs, not the shell's: in the document snapshot it
   * rendered elements the prelude never had, or left out ones it has (issue
   * #1035), and it got there or not by a race with the lane's first read.
   */
  freezeDocumentSnapshot(): void;

  /**
   * Get an async iterator that yields handle data on each push.
   * Completes at the chosen settlement barrier: "fullySettled" (default —
   * nav/action payloads, whose consumer applies each yield progressively) or
   * "settled" (the document lane, whose consumers drain to completion in
   * blocking positions and must not wait on loader bodies).
   * Each yield contains the full accumulated state (not just the delta).
   * Safe for concurrent consumers (per-consumer version cursor).
   * The "settled" lane of a frozen store (freezeDocumentSnapshot) yields the
   * frozen state once, at once, and ends. That yield is the store's own
   * frozen object: a consumer must not write to it.
   */
  stream(
    until?: "settled" | "fullySettled",
  ): AsyncGenerator<HandleData, void, unknown>;

  /**
   * Document-lane late channel: yields full-state updates for pushes that
   * land AFTER the handler barrier (streaming loader bodies), completing at
   * fullySettled. Returns without yielding when the auxiliary lane is empty
   * by the time `settled` resolves. The client consumes this post-hydration
   * (rsc-router.tsx) and merges via the same application path as nav-lane
   * progressive handle updates. On a frozen store (freezeDocumentSnapshot)
   * it starts from the frozen state instead: a change made before the
   * handler barrier is late too.
   */
  streamLate(): AsyncGenerator<HandleData, void, unknown>;

  /**
   * Get handle data for a specific segment (for caching).
   * Returns data in format: { handleName: [values...] }
   *
   * `excludeLoaderPushes` drops values tagged as DSL-loader pushes at push
   * time (see push); see captureHandles.
   */
  getDataForSegment(
    segmentId: string,
    excludeLoaderPushes?: boolean,
  ): Record<string, unknown[]>;

  /**
   * The push `owner` of each value in getDataForSegment(segmentId, true),
   * index-aligned per handle (null: no owner). Handles without an owned
   * value are omitted; undefined when none has one.
   */
  getRecordOwners(
    segmentId: string,
  ): Record<string, (string | null)[]> | undefined;

  /** The segment ids for which getRecordOwners returns an entry. */
  getOwnedSegmentIds(): string[];

  /**
   * Replay cached handle data back into the store (for cache hits).
   * Used to restore handle data when serving cached segments.
   */
  replaySegmentData(
    segmentId: string,
    segmentHandles: Record<string, unknown[]>,
  ): void;
}

/**
 * Create a new HandleStore instance.
 *
 * @example
 * ```ts
 * const handleStore = createHandleStore();
 *
 * // In router - track without awaiting
 * const component = handleStore.track(entry.handler(context));
 *
 * // In handler - push handle data (value, promise, or async callback result)
 * handleStore.push("breadcrumbs", segmentId, { label: "Home", href: "/" });
 * handleStore.push("meta", segmentId, fetchMetaAsync()); // promise
 *
 * // Stream handle data progressively
 * for await (const handles of handleStore.stream()) {
 *   console.log("Handle update:", handles);
 * }
 * ```
 */
export function createHandleStore(): HandleStore {
  const data: HandleData = {};
  // SlotTag arrays, keyed by the per-handle/segment values array. Positional
  // (not value identity) so primitive values are covered too.
  // replaySegmentData installs fresh arrays, so restored values are untagged.
  const slotTags = new WeakMap<unknown[], (SlotTag | undefined)[]>();
  // Copies standing in for a loader that has not pushed live yet: loaderId ->
  // the arrays holding them. Kept apart by kind: only a placeholder gives way
  // to a run that ends without a push, or to a cached unit's delivery.
  const pendingReplays = new Map<string, Set<unknown[]>>();
  const pendingPlaceholders = new Map<string, Set<unknown[]>>();
  // Loaders whose live run already replaced its copies.
  const replaced = new Set<string>();
  // Loaders a record restored standing copies for (pushRestored), and those
  // it restored placeholders for (pushPlaceholder).
  const restoredLoaders = new Set<string>();
  const placeholderLoaders = new Set<string>();
  let authority: ((loaderId: string) => RecordAuthority) | undefined;
  const isRestored = (loaderId: string): boolean =>
    restoredLoaders.has(loaderId) || authority?.(loaderId) === "pin";
  const isHole = (loaderId: string): boolean =>
    placeholderLoaders.has(loaderId) || authority?.(loaderId) === "hole";

  const hasCopies = (loaderId: string): boolean =>
    pendingReplays.has(loaderId) ||
    pendingPlaceholders.has(loaderId) ||
    replaced.has(loaderId);

  // The restored loader a push counts for, as the capture credits it
  // (shell-capture.ts deriveShellCaptureContext): the replayed loader when it
  // is restored, else the innermost enclosing loader body that is. A
  // "use cache" hit inside a restored body replays a dependency's push the
  // capture recorded under that body. A hole's body, or a replay of a hole's
  // push, ends the search: a live loader a restored loader awaits is still
  // live.
  function restoringLoader(replayOf: string | undefined): string | undefined {
    if (replayOf !== undefined) {
      if (isRestored(replayOf)) return replayOf;
      // Defensive: a hole's own cache() replay runs outside any loader body,
      // so the walk below finds no restored loader either.
      if (isHole(replayOf)) return undefined;
    }
    return findEnclosingLoaderBody(isRestored, isHole);
  }
  // The copy whose this.push() is in flight, as the tag its slot takes. Set
  // around the call, not passed, so a capture wrapping push() sees it as a
  // push.
  let replaying:
    | Pick<SlotTag, "replayOf" | "placeholderOf" | "restoredOf">
    | undefined;
  // A replacePlaceholders delivery in flight: per array, where its next
  // pushReplayed value goes (the removed values' place).
  let redelivery: Map<unknown[], number> | undefined;

  // Aligned to `values` so a mid-array insert or removal keeps positions.
  function tagsFor(values: unknown[]): (SlotTag | undefined)[] {
    let tags = slotTags.get(values);
    if (!tags) slotTags.set(values, (tags = []));
    if (tags.length < values.length) tags.length = values.length;
    return tags;
  }

  function insertSlot(
    values: unknown[],
    at: number | undefined,
    value: unknown,
    tag: SlotTag | undefined,
  ): void {
    if (at === undefined || at >= values.length) {
      values.push(value);
      if (tag) tagsFor(values)[values.length - 1] = tag;
      return;
    }
    const tags = tagsFor(values);
    values.splice(at, 0, value);
    tags.splice(at, 0, tag);
  }

  // Remove the slots `drops` accepts; returns the first one's position.
  function removeSlots(
    values: unknown[],
    drops: (tag: SlotTag) => boolean,
  ): number | undefined {
    const tags = slotTags.get(values);
    if (!tags) return undefined;
    let first: number | undefined;
    let kept = 0;
    for (let i = 0; i < values.length; i++) {
      const tag = tags[i];
      if (tag && drops(tag)) {
        first ??= kept;
        continue;
      }
      values[kept] = values[i];
      tags[kept] = tag;
      kept++;
    }
    values.length = kept;
    tags.length = kept;
    return first;
  }

  // After the last push of `loaderId`'s run in `values`: its own, or one made
  // in a body it entered. undefined: none yet.
  function runCursor(loaderId: string, values: unknown[]): number | undefined {
    const tags = slotTags.get(values);
    if (!tags) return undefined;
    for (let i = tags.length - 1; i >= 0; i--) {
      const tag = tags[i];
      if (tag?.liveOf === loaderId || tag?.under?.includes(loaderId)) {
        return i + 1;
      }
    }
    return undefined;
  }

  // The loaders around `pusher`'s body, innermost first, whose runs replaced
  // copies (SlotTag.under).
  function replacedAround(pusher: string): string[] | undefined {
    let around: string[] | undefined;
    let outside = false;
    findEnclosingLoaderBody((loaderId) => {
      if (outside && replaced.has(loaderId)) (around ??= []).push(loaderId);
      if (loaderId === pusher) outside = true;
      return false;
    });
    return around;
  }

  // Remove `loaderId`'s pending placeholders, and its replays with `replays`.
  // Returns the first position removed from `values`.
  function dropCopies(
    loaderId: string,
    replays: boolean,
    values?: unknown[],
  ): number | undefined {
    const placeholderArrays = pendingPlaceholders.get(loaderId);
    const replayArrays = replays ? pendingReplays.get(loaderId) : undefined;
    if (!placeholderArrays && !replayArrays) return undefined;
    pendingPlaceholders.delete(loaderId);
    if (replayArrays) pendingReplays.delete(loaderId);
    replaced.add(loaderId);
    const own = (tag: SlotTag): boolean =>
      tag.placeholderOf === loaderId || (replays && tag.replayOf === loaderId);
    let at: number | undefined;
    for (const arrays of [placeholderArrays, replayArrays]) {
      if (!arrays) continue;
      for (const copied of arrays) {
        const first = removeSlots(copied, own);
        if (copied === values) at ??= first;
      }
    }
    return at;
  }

  // Where a live push by a loader with copies lands in `values`: its first
  // push removes all of its copies and takes the first one's position in this
  // array; later pushes follow the last push of its run. undefined: no place
  // of its own here.
  function liveReplacementIndex(
    loaderId: string,
    values: unknown[],
  ): number | undefined {
    return dropCopies(loaderId, true, values) ?? runCursor(loaderId, values);
  }

  function addPending(
    pending: Map<string, Set<unknown[]>>,
    loaderId: string,
    values: unknown[],
  ): void {
    let arrays = pending.get(loaderId);
    if (!arrays) pending.set(loaderId, (arrays = new Set()));
    arrays.add(values);
  }

  // A restored loader's settled push: the first of its restored slots here
  // not yet matched stands in for it. Returns nothing; the push is dropped.
  function matchRestoredSlot(values: unknown[], loaderId: string): void {
    const tags = slotTags.get(values);
    if (!tags) return;
    for (let i = 0; i < values.length; i++) {
      const tag = tags[i];
      if (tag?.restoredOf === loaderId && !tag.matched) {
        tags[i] = { ...tag, matched: true };
        return;
      }
    }
  }

  // Where a kept push by a restored loader lands: before its first unmatched
  // restored slot here (it came before that push), else after its last slot
  // here, else appended.
  function restoredInsertIndex(
    values: unknown[],
    loaderId: string,
  ): number | undefined {
    const tags = slotTags.get(values);
    if (!tags) return undefined;
    let after: number | undefined;
    for (let i = 0; i < values.length; i++) {
      const tag = tags[i];
      if (tag?.restoredOf === loaderId && !tag.matched) return i;
      if (
        tag?.restoredOf === loaderId ||
        tag?.liveOf === loaderId ||
        tag?.replayOf === loaderId
      ) {
        after = i + 1;
      }
    }
    return after;
  }

  function replayPush(
    store: HandleStore,
    replay: NonNullable<typeof replaying>,
    handleName: string,
    segmentId: string,
    value: unknown,
  ): void {
    replaying = replay;
    try {
      store.push(handleName, segmentId, value);
    } finally {
      replaying = undefined;
    }
  }

  // Settlement barriers: `settled` (handler lane) resolves when sealed AND
  // handler inflight === 0. `fullySettled` additionally waits for the
  // auxiliary (loader) lane. seal() signals "no more track() calls"; each
  // track/trackAuxiliary increments its lane's count, each promise settle
  // decrements. Barriers resolve once their conditions are met — even if
  // tracks are added while earlier ones are still in flight.
  let sealed = false;
  let inflightCount = 0;
  let auxInflightCount = 0;
  let drainWaiters: (() => void)[] = [];
  let fullDrainWaiters: (() => void)[] = [];

  // Swap the waiter list out before resolving: a resolver may synchronously
  // re-await and push onto the fresh list, which must not be drained by this
  // pass. All three waiter lists (drain, full-drain, emission) flush through
  // here so that ordering rule cannot drift between them.
  function flushWaiters(waiters: (() => void)[]): void {
    for (const resolve of waiters) resolve();
  }

  // Both lanes settle identically — the handler lane (`track`) gates `settled`,
  // the auxiliary loader lane (`trackAuxiliary`) gates `fullySettled`. Shared so
  // neither copy can lose this rule: .then() rather than .finally(), because
  // .finally() re-throws on a NEW branch, producing an unhandled rejection that
  // can crash the process when the tracked promise rejects.
  function trackSettlement<T>(
    promise: Promise<T>,
    release: () => void,
  ): Promise<T> {
    const onSettle = () => {
      release();
      notifyDrain();
    };
    promise.then(onSettle, onSettle);
    return promise;
  }

  function notifyDrain() {
    if (sealed && inflightCount === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      flushWaiters(waiters);
    }
    if (sealed && inflightCount === 0 && auxInflightCount === 0) {
      if (streamConsumed && !completed) {
        // Late-push guard + stream termination key on FULL drain, so a
        // streaming loader body's ctx.handle() push stays legal until the
        // auxiliary lane empties. Armed only once a stream consumer exists —
        // getData()-only paths (prerender collection) keep their historical
        // no-guard behavior.
        completed = true;
        signalEmission();
      }
      if (fullDrainWaiters.length > 0) {
        const waiters = fullDrainWaiters;
        fullDrainWaiters = [];
        flushWaiters(waiters);
      }
    }
  }

  function sealInternal() {
    if (sealed) return;
    sealed = true;
    notifyDrain();
  }

  // Emission versioning. Each push bumps `version`; every stream consumer
  // keeps its own cursor and yields whenever the version advanced past it.
  // Multi-consumer safe (the document "settled" stream and the late channel
  // overlap until the handler barrier): a single dirty bit + single resolver
  // slot would drop wakeups for all but one consumer.
  let version = 0;
  let emissionWaiters: (() => void)[] = [];
  let completed = false;
  let streamConsumed = false;
  // freezeDocumentSnapshot: the state the document lane serves, and the
  // version the late channel starts after.
  let documentSnapshot: { version: number; data: HandleData } | undefined;
  // A stream("settled") consumer started on the live state: a freeze after
  // that does not reach it.
  let documentStreamRead = false;

  // Wake every waiting consumer (new push or a settlement barrier fired).
  function signalEmission() {
    if (emissionWaiters.length > 0) {
      const waiters = emissionWaiters;
      emissionWaiters = [];
      flushWaiters(waiters);
    }
  }

  // Wait for the next emission or completion
  // Resolve when the consumer's cursor is behind the current version, the
  // given done-flag reader reports termination, or a new signal arrives.
  function waitForEmission(seen: number, isDone: () => boolean): Promise<void> {
    if (version > seen || isDone()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      emissionWaiters.push(resolve);
    });
  }

  return {
    track<T>(promise: Promise<T>): Promise<T> {
      inflightCount++;
      return trackSettlement(promise, () => {
        inflightCount--;
      });
    },

    trackAuxiliary<T>(promise: Promise<T>): Promise<T> {
      auxInflightCount++;
      return trackSettlement(promise, () => {
        auxInflightCount--;
      });
    },

    seal() {
      sealInternal();
    },

    get settled(): Promise<void> {
      if (sealed && inflightCount === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    get fullySettled(): Promise<void> {
      if (sealed && inflightCount === 0 && auxInflightCount === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        fullDrainWaiters.push(resolve);
      });
    },

    push(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderPush?: boolean,
      owner?: string,
    ): void {
      if (completed) {
        const error = createLateHandlePushError(handleName, segmentId);
        if (this.onError) this.onError(error);
        throw error;
      }

      const { replayOf, placeholderOf, restoredOf } = replaying ?? {};
      // A record's copy is no loader's push. Any other push, while a loader
      // has copies or a restore to reconcile, is attributed as the capture
      // credits it: to the innermost loader body it is made in that has
      // copies, up to a hole's body, so a replay made in a body replaces
      // that body's copies and a dependency's push replaces those of the
      // live-lane loader it ran under. Its record copy stands when a
      // restored loader counts it (restoringLoader).
      let pusher: string | undefined;
      let restoredBy: string | undefined;
      if (restoredOf === undefined && placeholderOf === undefined) {
        if (
          pendingReplays.size > 0 ||
          pendingPlaceholders.size > 0 ||
          replaced.size > 0
        ) {
          pusher = findEnclosingLoaderBody(hasCopies, isHole);
        }
        if (restoredLoaders.size > 0 || authority) {
          restoredBy = restoringLoader(replayOf);
        }
      }
      if (restoredBy !== undefined && !holdsThenable(value)) {
        const existing = data[handleName]?.[segmentId];
        if (existing) matchRestoredSlot(existing, restoredBy);
        return;
      }

      if (!data[handleName]) {
        data[handleName] = {};
      }
      if (!data[handleName][segmentId]) {
        data[handleName][segmentId] = [];
      }
      const values = data[handleName][segmentId];
      const loader = (loaderPush ?? isInsideLoaderScope()) || undefined;
      let at: number | undefined;
      let liveOf: string | undefined;
      let under: string[] | undefined;
      if (restoredOf !== undefined) {
        restoredLoaders.add(restoredOf);
      } else if (placeholderOf !== undefined) {
        placeholderLoaders.add(placeholderOf);
      } else if (replayOf !== undefined && redelivery?.has(values)) {
        at = redelivery.get(values)!;
        redelivery.set(values, at + 1);
      } else if (pusher !== undefined) {
        under = replacedAround(pusher);
        at = liveReplacementIndex(pusher, values);
        // No place of its own here: it follows the run it was made in.
        for (let i = 0; at === undefined && under && i < under.length; i++) {
          at = runCursor(under[i]!, values);
        }
        liveOf = pusher;
      } else if (restoredBy !== undefined) {
        at = restoredInsertIndex(values, restoredBy);
        if (replayOf === undefined) liveOf = restoredBy;
      }
      insertSlot(
        values,
        at,
        value,
        replayOf !== undefined ||
          placeholderOf !== undefined ||
          restoredOf !== undefined ||
          liveOf !== undefined ||
          owner !== undefined
          ? {
              loader,
              replayOf,
              placeholderOf,
              restoredOf,
              liveOf,
              under,
              owner,
            }
          : loader
            ? LOADER_SLOT
            : undefined,
      );
      if (replayOf !== undefined) {
        addPending(pendingReplays, replayOf, values);
      } else if (placeholderOf !== undefined) {
        addPending(pendingPlaceholders, placeholderOf, values);
      }

      // Bump the version; each consumer's cursor decides when to clone+yield.
      version++;
      signalEmission();
    },

    // All three go through this.push: active captures see a copy like a live
    // push, and a diverting capture keeps it out of the store.
    pushReplayed(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderId: string,
    ): void {
      replayPush(this, { replayOf: loaderId }, handleName, segmentId, value);
    },

    pushPlaceholder(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderId: string,
    ): void {
      replayPush(
        this,
        { placeholderOf: loaderId },
        handleName,
        segmentId,
        value,
      );
    },

    pushRestored(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderId: string,
    ): void {
      replayPush(this, { restoredOf: loaderId }, handleName, segmentId, value);
    },

    setRecordAuthority(of: (loaderId: string) => RecordAuthority): void {
      authority = of;
    },

    settleLoaderRun(loaderId: string): void {
      if (completed) return;
      const hole = isHole(loaderId);
      if (
        !pendingPlaceholders.has(loaderId) &&
        !(hole && pendingReplays.has(loaderId))
      ) {
        return;
      }
      dropCopies(loaderId, hole);
      version++;
      signalEmission();
    },

    replacePlaceholders(
      loaderIds: readonly string[],
      deliver: () => void,
    ): void {
      // One pass per array over every loader's placeholders: an array two of
      // them share gets one anchor, the first removed position.
      let given: Set<string> | undefined;
      let arrays: Set<unknown[]> | undefined;
      if (!completed) {
        for (const loaderId of loaderIds) {
          const pending = pendingPlaceholders.get(loaderId);
          if (!pending) continue;
          pendingPlaceholders.delete(loaderId);
          (given ??= new Set()).add(loaderId);
          arrays ??= new Set();
          for (const values of pending) arrays.add(values);
        }
      }
      if (!given || !arrays) {
        deliver();
        return;
      }
      const owners = given;
      const ofGiven = (tag: SlotTag): boolean =>
        tag.placeholderOf !== undefined && owners.has(tag.placeholderOf);
      const anchors = new Map<unknown[], number>();
      for (const values of arrays) {
        const first = removeSlots(values, ofGiven);
        if (first !== undefined) anchors.set(values, first);
      }
      const outer = redelivery;
      redelivery = anchors;
      try {
        deliver();
      } finally {
        redelivery = outer;
      }
      version++;
      signalEmission();
    },

    getData(): Promise<HandleData> {
      sealInternal();
      return this.settled.then(() => cloneHandleData(data));
    },

    freezeDocumentSnapshot(): void {
      if (documentSnapshot) return;
      if (process.env.NODE_ENV !== "production" && documentStreamRead) {
        const error = new Error(
          "HandleStore.freezeDocumentSnapshot() ran after the document's " +
            'handle stream (stream("settled")) was first read. That stream ' +
            "keeps reading the live store, so the document hydrates with " +
            "whatever a loader pushed by then instead of the frozen state " +
            "(issue #1035). Freeze before the payload that carries the " +
            "stream starts rendering.",
        );
        if (this.onError) this.onError(error);
        else console.error(error);
      }
      documentSnapshot = { version, data: cloneHandleData(data) };
    },

    async *stream(
      until: "settled" | "fullySettled" = "fullySettled",
    ): AsyncGenerator<HandleData, void, unknown> {
      streamConsumed = true;
      sealInternal();
      // Re-evaluate: the store may have been sealed and drained BEFORE this
      // consumer existed (seal() then stream()); sealInternal early-returns
      // then, so the completed flag must be armed here.
      notifyDrain();

      if (until === "settled") {
        // A frozen document lane cannot change, so it is served at once:
        // SSR and the pre-hydration drain block on this stream, and the
        // batching hop below would cost every shell HIT a timer tick. It is
        // yielded as the frozen object itself, already a copy: the lane's
        // one consumer (resolvedHandleStream) builds a new object from a
        // yield and never writes to it.
        if (documentSnapshot) {
          if (Object.keys(documentSnapshot.data).length > 0) {
            yield documentSnapshot.data;
          }
          return;
        }
        documentStreamRead = true;
      }

      // Per-consumer termination flag driven by the chosen barrier. The
      // global `completed` (late-push guard) always keys on FULL drain via
      // notifyDrain — a "settled"-scoped consumer finishing does not make
      // later loader pushes illegal.
      let done = false;
      const barrier = until === "settled" ? this.settled : this.fullySettled;
      barrier.then(() => {
        done = true;
        signalEmission();
      });

      // Batch rapid synchronous pushes with initial delay
      await new Promise((resolve) => setTimeout(resolve, 0));

      let seen = 0;
      while (true) {
        if (version > seen && Object.keys(data).length > 0) {
          seen = version;
          yield cloneHandleData(data);
        }
        if (done) break;
        await waitForEmission(seen, () => done);
      }
    },

    async *streamLate(): AsyncGenerator<HandleData, void, unknown> {
      streamConsumed = true;
      sealInternal();
      // Re-evaluate: the store may have been sealed and drained BEFORE this
      // consumer existed (seal() then stream()); sealInternal early-returns
      // then, so the completed flag must be armed here.
      notifyDrain();

      // Skip everything the handler-barrier snapshot already carried; the
      // document consumers (SSR seed + pre-hydration drain) deliver that
      // state. This channel exists only for pushes that land AFTER `settled`
      // — streaming loader bodies writing meta/breadcrumbs mid-body.
      await this.settled;
      // A frozen document snapshot carried nothing newer than its version.
      let seen = documentSnapshot?.version ?? version;
      if (auxInflightCount === 0 && version === seen) {
        // Auxiliary lane already drained: every loader push (if any) beat the
        // handler barrier and rode the normal snapshot. Nothing late follows —
        // handler pushes after settled are illegal by contract.
        return;
      }

      let done = false;
      this.fullySettled.then(() => {
        done = true;
        signalEmission();
      });

      while (true) {
        if (version > seen) {
          seen = version;
          yield cloneHandleData(data);
        }
        if (done) break;
        await waitForEmission(seen, () => done);
      }
    },

    getDataForSegment(
      segmentId: string,
      excludeLoaderPushes?: boolean,
    ): Record<string, unknown[]> {
      const result: Record<string, unknown[]> = {};
      for (const handleName in data) {
        const values = data[handleName][segmentId];
        if (!values) continue;
        const tags = excludeLoaderPushes ? slotTags.get(values) : undefined;
        if (!tags) {
          result[handleName] = [...values];
          continue;
        }
        const kept = values.filter((_, i) => !tags[i]?.loader);
        if (kept.length > 0) result[handleName] = kept;
      }
      return result;
    },

    getRecordOwners(
      segmentId: string,
    ): Record<string, (string | null)[]> | undefined {
      let result: Record<string, (string | null)[]> | undefined;
      for (const handleName in data) {
        const values = data[handleName][segmentId];
        const tags = values && slotTags.get(values);
        if (!tags) continue;
        const owners: (string | null)[] = [];
        let owned = false;
        for (let i = 0; i < values.length; i++) {
          if (tags[i]?.loader) continue;
          const owner = tags[i]?.owner ?? null;
          if (owner) owned = true;
          owners.push(owner);
        }
        if (owned) (result ??= {})[handleName] = owners;
      }
      return result;
    },

    getOwnedSegmentIds(): string[] {
      const ids = new Set<string>();
      for (const handleName in data) {
        for (const id in data[handleName]) {
          if (!ids.has(id) && this.getRecordOwners(id)) ids.add(id);
        }
      }
      return [...ids];
    },

    replaySegmentData(
      segmentId: string,
      segmentHandles: Record<string, unknown[]>,
    ): void {
      for (const handleName in segmentHandles) {
        if (!data[handleName]) {
          data[handleName] = {};
        }
        // Replace (not append) to avoid handle bleeding between routes.
        // Cached segment restoration should replace existing data for that
        // segment, not accumulate on top of data from a different route.
        data[handleName][segmentId] = [...segmentHandles[handleName]];
      }
      version++;
      signalEmission();
    },
  };
}
