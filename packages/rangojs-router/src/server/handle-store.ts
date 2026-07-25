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
   */
  push(handleName: string, segmentId: string, data: unknown): void;

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
   */
  getDataForSegment(segmentId: string): Record<string, unknown[]>;

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

    push(handleName: string, segmentId: string, value: unknown): void {
      if (completed) {
        const error = createLateHandlePushError(handleName, segmentId);
        if (this.onError) this.onError(error);
        throw error;
      }

      if (!data[handleName]) {
        data[handleName] = {};
      }
      if (!data[handleName][segmentId]) {
        data[handleName][segmentId] = [];
      }
      data[handleName][segmentId].push(value);

      // Bump the version; each consumer's cursor decides when to clone+yield.
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

    getDataForSegment(segmentId: string): Record<string, unknown[]> {
      const result: Record<string, unknown[]> = {};
      for (const handleName in data) {
        if (data[handleName][segmentId]) {
          result[handleName] = [...data[handleName][segmentId]];
        }
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
