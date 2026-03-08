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
 * Deep clone handle data to create a snapshot.
 * @internal
 */
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
   * Push handle data for a specific handle and segment.
   * Multiple pushes to the same handle/segment accumulate in an array.
   * Each push triggers an emission on the stream.
   */
  push(handleName: string, segmentId: string, data: unknown): void;

  /**
   * Get all collected handle data after all handlers have settled.
   * Waits for `settled`, then returns the finalized data.
   */
  getData(): Promise<HandleData>;

  /**
   * Get an async iterator that yields handle data on each push.
   * The iterator completes when all handlers have settled.
   * Each yield contains the full accumulated state (not just the delta).
   */
  stream(): AsyncGenerator<HandleData, void, unknown>;

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

  // Settlement barrier: resolved only when sealed AND inflight === 0.
  // seal() signals "no more track() calls". Each track() increments
  // inflightCount, each promise.finally() decrements. settled resolves
  // once both conditions are met — even if tracks are added while
  // earlier ones are still in flight.
  let sealed = false;
  let inflightCount = 0;
  let drainWaiters: (() => void)[] = [];

  function notifyDrain() {
    if (sealed && inflightCount === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function sealInternal() {
    if (sealed) return;
    sealed = true;
    notifyDrain();
  }

  // Queue for pending emissions and resolver for waiting consumer
  let pendingEmissions: HandleData[] = [];
  let emissionResolver: (() => void) | null = null;
  let completed = false;

  // Signal that a new emission is available
  function signalEmission() {
    if (emissionResolver) {
      const resolver = emissionResolver;
      emissionResolver = null;
      resolver();
    }
  }

  // Wait for the next emission or completion
  function waitForEmission(): Promise<void> {
    if (pendingEmissions.length > 0 || completed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      emissionResolver = resolve;
    });
  }

  return {
    track<T>(promise: Promise<T>): Promise<T> {
      inflightCount++;
      // Use .then(onSettle, onSettle) instead of .finally() to avoid
      // creating an unhandled rejection branch when the tracked promise
      // rejects (e.g. error route handlers). .finally() re-throws the
      // rejection on a new branch that nobody catches, which can crash
      // the server process.
      const onSettle = () => {
        inflightCount--;
        notifyDrain();
      };
      promise.then(onSettle, onSettle);
      return promise;
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

      // Queue a snapshot for emission
      pendingEmissions.push(cloneHandleData(data));
      signalEmission();
    },

    getData(): Promise<HandleData> {
      sealInternal();
      return this.settled.then(() => cloneHandleData(data));
    },

    async *stream(): AsyncGenerator<HandleData, void, unknown> {
      // Auto-seal: stream() is called after all track() registrations.
      sealInternal();

      // Set up completion handler
      this.settled.then(() => {
        completed = true;
        signalEmission();
      });

      // Initial small delay to batch rapid synchronous pushes
      // This allows multiple handles pushing in quick succession to be batched
      await new Promise((resolve) => setTimeout(resolve, 0));

      // If we already have data, yield the accumulated state
      if (Object.keys(data).length > 0) {
        // Clear pending emissions since we're yielding current state
        pendingEmissions = [];
        const snapshot = cloneHandleData(data);
        yield snapshot;
      }

      // Continue streaming on each push
      while (!completed) {
        await waitForEmission();

        // Yield all pending emissions (yield latest only)
        if (pendingEmissions.length > 0) {
          // Skip intermediate states, yield the latest
          const latest = pendingEmissions[pendingEmissions.length - 1];
          pendingEmissions = [];
          yield latest;
        }
      }

      // Final yield only if there are pending emissions that weren't yielded
      // (handles that pushed after our last yield but before completion)
      if (pendingEmissions.length > 0) {
        yield cloneHandleData(data);
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
        // Replace with replayed data (not append) to avoid handle bleeding between routes.
        // When a cached segment is restored, its handles should replace any existing data
        // for that segment, not accumulate on top of data from a different route.
        data[handleName][segmentId] = [...segmentHandles[handleName]];
      }
      // Trigger emission for streaming
      pendingEmissions.push(cloneHandleData(data));
      signalEmission();
    },
  };
}
