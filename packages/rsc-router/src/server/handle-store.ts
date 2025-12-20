import type { ReactNode } from "react";

/**
 * HandleStore tracks pending handler promises.
 *
 * Used to know when all route/layout handlers have resolved,
 * without changing the existing await behavior.
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
 * // After rendering - wait for all handlers
 * await handleStore.settled;
 * ```
 */
export function createHandleStore(): HandleStore {
  const pending: Promise<unknown>[] = [];

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
  };
}
