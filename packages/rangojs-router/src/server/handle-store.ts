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
  /** A loader-cache replay of this loader's recorded push (pushReplayed). */
  replayOf?: string;
  /** Pushed by this loader's live run after it replaced its replayed slots. */
  liveOf?: string;
  /** Pushed by this loader's body and kept in records (push `owner`). */
  owner?: string;
  /** A document HIT's restore of this loader's record copy (pushRestored). */
  restoredOf?: string;
  /** A restored slot a dropped settled push of its loader stood in for. */
  matched?: true;
}

// Shared by every plain DSL-loader push; tags are never mutated in place.
const LOADER_SLOT: SlotTag = Object.freeze({ loader: true });

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
   * push() a loader-cache HIT's replayed value, recorded from `loaderId`'s
   * body (loader-cache.ts replayLoaderHandles). If that loader then runs live
   * in this request, its first push removes every value replayed for it and
   * takes the first one's position (later live pushes follow it), so the
   * handle output stays live without a duplicate. A push counts as that
   * loader's when it is made in its body, or in a body it entered that has
   * no replayed values of its own (the capture credits a dependency's push
   * under a live-lane loader to that loader); a hole's run that ends without
   * one drops them (settleLoaderRun).
   */
  pushReplayed(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderId: string,
  ): void;

  /**
   * push() a document HIT's copy of `loaderId`'s settled push, restored from
   * the shell's doc record (handle-snapshot.ts restoreHandles). The record is
   * authoritative for that loader's settled pushes: the prelude was rendered
   * from it, and a run of the loader on the HIT reads the store, not the
   * capture's values. So from then on this request drops every settled,
   * thenable-free push the loader makes (live, or replayed from a cache
   * entry, anywhere inside its body), and keeps the ones holding a thenable
   * (holdsThenable: what the record could not keep, `runs`), placed among the
   * restored copies in the loader's push order. Only bake-lane owners are
   * restored this way (withCacheLookup): a live-lane loader is a hole.
   */
  pushRestored(
    handleName: string,
    segmentId: string,
    data: unknown,
    loaderId: string,
  ): void;

  /**
   * The loaders the route runs on the live lane (liveLaneLoaderIds), from a
   * PPR shell record's restore (handle-snapshot.ts restoreHandles): the
   * holes. A push counts for a restored loader when that loader is the
   * replayed one or the innermost enclosing loader body that restored
   * copies; the walk out through enclosing bodies stops at a hole's body,
   * and a replay of a hole's push counts for none. So a restored loader
   * never takes a push made inside a hole it awaited, while a body inside the
   * hole that restored copies of its own (a dependency the capture ran under
   * a bake-lane loader) still takes its pushes.
   */
  markLiveLane(loaderIds: ReadonlySet<string>): void;

  /**
   * `loaderId`'s run in this request settled (resolved or rejected), its
   * pushes made (loader-resolution.ts createLoaderExecutor). When the loader
   * is a hole (markLiveLane), values replayed for it that no push of the run
   * replaced are dropped: the run's output decides, so a hole that throws or
   * skips its push shows none rather than the capture's. Any other loader's
   * replayed values stay: a bake-lane loader's record is authoritative for
   * its settled pushes, as its pin is for its data. Restored copies are not
   * replays and stand.
   */
  settleLoaderRun(loaderId: string): void;

  /**
   * A hole's own cache() HIT (loader-cache.ts replayLoaderHandles, once it
   * claims the hole): the values replayed for hole `loaderId` before (its
   * shell copies, which restoreHandles leaves unclaimed, those of the
   * dependencies credited to it included) give way to the pushes the entry
   * recorded, none when it recorded none, so they match the entry's data.
   * `deliver` makes the pushReplayed calls, which take the removed values'
   * place in each array. Any other loader, or a hole with nothing replayed,
   * delivers as a plain replay.
   */
  redeliverReplays(loaderId: string, deliver: () => void): void;

  /**
   * Get all collected handle data after all handlers have settled.
   * Waits for `settled` (handler lane), then returns the data at that point.
   */
  getData(): Promise<HandleData>;

  /**
   * Get an async iterator that yields handle data on each push.
   * Completes at the chosen settlement barrier: "fullySettled" (default —
   * nav/action payloads, whose consumer applies each yield progressively) or
   * "settled" (the document lane, whose consumers drain to completion in
   * blocking positions and must not wait on loader bodies).
   * Each yield contains the full accumulated state (not just the delta).
   * Safe for concurrent consumers (per-consumer version cursor).
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
   * progressive handle updates.
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
  // Replayed loaders that have not pushed live yet: loaderId -> the arrays
  // holding their replayed slots.
  const pendingReplays = new Map<string, Set<unknown[]>>();
  // Replayed loaders whose live run already replaced those slots.
  const replacedReplays = new Set<string>();
  // Loaders a document HIT restored record copies for (pushRestored).
  const restoredLoaders = new Set<string>();
  const isRestored = (loaderId: string): boolean =>
    restoredLoaders.has(loaderId);
  // The route's live-lane loaders (markLiveLane): holes a restore never
  // reaches into.
  let liveLane: ReadonlySet<string> | undefined;
  const isHole = (loaderId: string): boolean =>
    liveLane?.has(loaderId) ?? false;

  const hasReplays = (loaderId: string): boolean =>
    pendingReplays.has(loaderId) || replacedReplays.has(loaderId);

  // The restored loader a push counts for, as the capture credits it
  // (shell-capture.ts deriveShellCaptureContext): the replayed loader when it
  // restored one, else the innermost enclosing loader body that did. A
  // "use cache" hit inside a restored body replays a dependency's push the
  // capture recorded under that body. A hole's body, or a replay of a hole's
  // push, ends the search: a live loader a restored loader awaits is still
  // live.
  function restoringLoader(replayOf: string | undefined): string | undefined {
    if (replayOf !== undefined) {
      if (restoredLoaders.has(replayOf)) return replayOf;
      // Defensive: a hole's own cache() replay runs outside any loader body,
      // so the walk below finds no restored loader either.
      if (isHole(replayOf)) return undefined;
    }
    return findEnclosingLoaderBody(isRestored, isHole);
  }
  // The replay or restore whose this.push() is in flight, as the tag its
  // slot takes. Set around the call, not passed, so a capture wrapping
  // push() sees it as a push.
  let replaying: Pick<SlotTag, "replayOf" | "restoredOf"> | undefined;
  // A redeliverReplays delivery in flight: per array, where its next
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

  // Remove `loaderId`'s replayed slots; returns the first one's position.
  function removeReplayedSlots(
    values: unknown[],
    loaderId: string,
  ): number | undefined {
    const tags = slotTags.get(values);
    if (!tags) return undefined;
    let first: number | undefined;
    let kept = 0;
    for (let i = 0; i < values.length; i++) {
      if (tags[i]?.replayOf === loaderId) {
        first ??= kept;
        continue;
      }
      values[kept] = values[i];
      tags[kept] = tags[i];
      kept++;
    }
    values.length = kept;
    tags.length = kept;
    return first;
  }

  // Where a live push by a replayed loader lands in `values`: its first push
  // removes all of its replayed slots and takes the first one's position in
  // this array; later pushes follow its previous live push. undefined appends.
  function liveReplacementIndex(
    loaderId: string,
    values: unknown[],
  ): number | undefined {
    const pending = pendingReplays.get(loaderId);
    if (pending) {
      pendingReplays.delete(loaderId);
      replacedReplays.add(loaderId);
      let at: number | undefined;
      for (const replayed of pending) {
        const first = removeReplayedSlots(replayed, loaderId);
        if (replayed === values) at = first;
      }
      return at;
    }
    const tags = slotTags.get(values);
    if (!tags) return undefined;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i]?.liveOf === loaderId) return i + 1;
    }
    return undefined;
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

      const { replayOf, restoredOf } = replaying ?? {};
      // A restore is no loader's push. Any other push, while a loader has
      // replayed or restored slots to reconcile, is attributed as the capture
      // credits it: to the innermost loader body it is made in that has
      // replayed slots, up to a hole's body, so a replay made in a body
      // replaces that body's replayed copies and a dependency's push replaces
      // those of the live-lane loader it ran under. Its record copy stands
      // when a restored loader counts it (restoringLoader).
      let pusher: string | undefined;
      let restoredBy: string | undefined;
      if (!restoredOf) {
        if (pendingReplays.size > 0 || replacedReplays.size > 0) {
          pusher = findEnclosingLoaderBody(hasReplays, isHole);
        }
        if (restoredLoaders.size > 0) restoredBy = restoringLoader(replayOf);
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
      if (restoredOf) {
        restoredLoaders.add(restoredOf);
      } else if (replayOf !== undefined && redelivery?.has(values)) {
        at = redelivery.get(values)!;
        redelivery.set(values, at + 1);
      } else if (pusher !== undefined) {
        at = liveReplacementIndex(pusher, values);
        liveOf = pusher;
      } else if (restoredBy !== undefined) {
        at = restoredInsertIndex(values, restoredBy);
        if (!replayOf) liveOf = restoredBy;
      }
      insertSlot(
        values,
        at,
        value,
        replayOf || liveOf || owner || restoredOf
          ? { loader, replayOf, liveOf, owner, restoredOf }
          : loader
            ? LOADER_SLOT
            : undefined,
      );
      if (replayOf) {
        let arrays = pendingReplays.get(replayOf);
        if (!arrays) pendingReplays.set(replayOf, (arrays = new Set()));
        arrays.add(values);
      }

      // Bump the version; each consumer's cursor decides when to clone+yield.
      version++;
      signalEmission();
    },

    // Both go through this.push: active captures see a replay like a live
    // push, and a diverting capture keeps it out of the store.
    pushReplayed(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderId: string,
    ): void {
      replayPush(this, { replayOf: loaderId }, handleName, segmentId, value);
    },

    pushRestored(
      handleName: string,
      segmentId: string,
      value: unknown,
      loaderId: string,
    ): void {
      replayPush(this, { restoredOf: loaderId }, handleName, segmentId, value);
    },

    markLiveLane(loaderIds: ReadonlySet<string>): void {
      liveLane = loaderIds;
    },

    settleLoaderRun(loaderId: string): void {
      const pending = pendingReplays.get(loaderId);
      if (!pending || completed || !isHole(loaderId)) return;
      pendingReplays.delete(loaderId);
      replacedReplays.add(loaderId);
      for (const values of pending) removeReplayedSlots(values, loaderId);
      version++;
      signalEmission();
    },

    redeliverReplays(loaderId: string, deliver: () => void): void {
      const pending = pendingReplays.get(loaderId);
      if (!pending || completed || !isHole(loaderId)) {
        deliver();
        return;
      }
      pendingReplays.delete(loaderId);
      const anchors = new Map<unknown[], number>();
      for (const values of pending) {
        const first = removeReplayedSlots(values, loaderId);
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

    async *stream(
      until: "settled" | "fullySettled" = "fullySettled",
    ): AsyncGenerator<HandleData, void, unknown> {
      streamConsumed = true;
      sealInternal();
      // Re-evaluate: the store may have been sealed and drained BEFORE this
      // consumer existed (seal() then stream()); sealInternal early-returns
      // then, so the completed flag must be armed here.
      notifyDrain();

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
      let seen = version;
      if (auxInflightCount === 0) {
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
