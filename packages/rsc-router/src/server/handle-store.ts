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
 * HandleStore tracks pending handler promises and stores handle data.
 *
 * Combines two responsibilities:
 * 1. Promise tracking - know when all handlers have resolved
 * 2. Data storage - collect handle data pushed by handlers
 */
export interface HandleStore {
  /**
   * Track a handler promise (non-blocking).
   * Returns the promise unchanged - just registers it for tracking.
   */
  track<T>(promise: Promise<T>): Promise<T>;

  /**
   * Promise that resolves when all tracked handlers have settled.
   * Does not reject - uses Promise.allSettled internally.
   */
  readonly settled: Promise<void>;

  /**
   * Push handle data for a specific handle and segment.
   * Multiple pushes to the same handle/segment accumulate in an array.
   */
  push(handleName: string, segmentId: string, data: unknown): void;

  /**
   * Get all collected handle data after all handlers have settled.
   * Returns a promise that waits for `settled`, then returns the data.
   * The data may contain unresolved promises which RSC will stream.
   */
  getData(): Promise<HandleData>;
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
 * // Get collected data for payload (waits for handlers to settle)
 * const handles = handleStore.getData(); // Promise<HandleData>
 * // The handles may contain unresolved promises that RSC will stream
 * ```
 */
export function createHandleStore(): HandleStore {
  const pending: Promise<unknown>[] = [];
  const data: HandleData = {};

  return {
    track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise);
      return promise;
    },

    get settled(): Promise<void> {
      if (pending.length === 0) {
        return Promise.resolve();
      }
      return Promise.allSettled(pending).then(() => {});
    },

    push(handleName: string, segmentId: string, value: unknown): void {
      if (!data[handleName]) {
        data[handleName] = {};
      }
      if (!data[handleName][segmentId]) {
        data[handleName][segmentId] = [];
      }
      data[handleName][segmentId].push(value);
    },

    getData(): Promise<HandleData> {
      return this.settled.then(() => data);
    },
  };
}
