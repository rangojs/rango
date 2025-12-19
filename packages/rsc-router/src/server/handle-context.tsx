/**
 * Request-scoped storage for handle data
 *
 * Uses AsyncLocalStorage to store handle data during server render.
 * Data is collected per-segment and included in RSC payload metadata.
 * The client runs the reducer to accumulate data from matched segments.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Handle } from "../handle.js";
import {
  registerGetSegmentId,
  registerRunWithSegment,
} from "../handle-segment-registry.js";

/**
 * Entry in the handle store - either resolved data or a promise
 */
export type HandleEntry<T = unknown> = T | Promise<T>;

/**
 * Per-segment entries for a handle
 * Maps segmentId -> array of entries from that segment
 */
type SegmentEntries = Map<string, HandleEntry[]>;

/**
 * Store for a single handle type
 */
interface HandleStoreEntry {
  entries: SegmentEntries;
}

/**
 * Async tracker for tracking pending async operations
 * Used to know when all handlers have completed so handles can be resolved
 */
interface AsyncTracker {
  track<T>(promise: Promise<T>): Promise<T>;
  wrap<T extends (...args: any[]) => Promise<any>>(fn: T): T;
  /** Promise that resolves when all tracked operations complete */
  settled: Promise<void>;
}

/**
 * Create an async tracker to track pending async operations
 * The settled promise resolves when all tracked operations complete
 *
 * Call done() to signal that no more operations will be tracked.
 * If nothing was tracked, done() resolves immediately.
 */
function createAsyncTracker(): AsyncTracker & { done(): void } {
  let pending = 0;
  let resolveSettle: () => void;
  let isSettled = false;
  let isDone = false;

  const settled = new Promise<void>((resolve) => {
    resolveSettle = resolve;
  });

  function checkSettle() {
    if (pending === 0 && isDone && !isSettled) {
      isSettled = true;
      resolveSettle();
    }
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending++;
    return promise.then(
      (value) => {
        pending--;
        queueMicrotask(checkSettle);
        return value;
      },
      (err) => {
        pending--;
        queueMicrotask(checkSettle);
        throw err;
      }
    );
  }

  function wrap<T extends (...args: any[]) => Promise<any>>(fn: T): T {
    return ((...args: Parameters<T>) => {
      return track(fn(...args));
    }) as T;
  }

  function done() {
    isDone = true;
    queueMicrotask(checkSettle);
  }

  return { track, wrap, settled, done };
}

/**
 * Request-scoped handle store
 */
interface HandleStore {
  handles: Map<string, HandleStoreEntry>;
  tracker: AsyncTracker & { done(): void };
}

/**
 * AsyncLocalStorage for handle data (request-scoped)
 */
export const HandleContext: AsyncLocalStorage<HandleStore> =
  new AsyncLocalStorage<HandleStore>();

/**
 * AsyncLocalStorage for current segment ID (execution-scoped)
 * This is separate from HandleContext so that concurrent executions
 * (like parallel loaders) each have their own isolated segment ID.
 */
export const SegmentContext: AsyncLocalStorage<string> =
  new AsyncLocalStorage<string>();

/**
 * Get the handle store for the current request
 */
function getHandleStore(): HandleStore | undefined {
  return HandleContext.getStore();
}

/**
 * Check if we're in a handle context
 */
export function hasHandleContext(): boolean {
  return HandleContext.getStore() !== undefined;
}

/**
 * Initialize handle context for a request
 */
export function initHandleContext(): HandleStore {
  return {
    handles: new Map(),
    tracker: createAsyncTracker(),
  };
}

/**
 * Run a callback within a handle context
 */
export function runWithHandleContext<T>(
  store: HandleStore,
  callback: () => T
): T {
  return HandleContext.run(store, callback);
}

/**
 * Run a callback with a specific segment ID context.
 * This creates an isolated execution context where getCurrentSegment()
 * returns this segment ID, even when running concurrently with other segments.
 */
export function runWithSegment<T>(segmentId: string, callback: () => T): T {
  return SegmentContext.run(segmentId, callback);
}

/**
 * Track an async handler with the current request's tracker.
 * The tracked promise is monitored so resolveHandles knows when all handlers complete.
 *
 * @param promise - The async handler result to track
 * @returns The same promise, now tracked
 */
export function trackHandler<T>(promise: Promise<T>): Promise<T> {
  const store = getHandleStore();
  if (!store) {
    return promise;
  }
  return store.tracker.track(promise);
}

/**
 * Signal that all handlers have been dispatched and no more will be tracked.
 * This allows the tracker to settle once pending handlers complete.
 * If no handlers were tracked, the tracker settles immediately.
 */
export function markHandlersDone(): void {
  const store = getHandleStore();
  if (store) {
    store.tracker.done();
  }
}

/**
 * Get the current segment ID from SegmentContext
 */
export function getCurrentSegment(): string | null {
  return SegmentContext.getStore() ?? null;
}

/**
 * Push data to a handle by name (called from server code)
 *
 * Handles are attributed to the segment where they are called.
 * The client accumulates handle data from all matched segments.
 *
 * @param name - The handle name to push data to
 * @param data - Data or async function returning data
 */
function pushHandleData(
  name: string,
  data: unknown | (() => unknown | Promise<unknown>)
): void {
  const store = getHandleStore();

  if (!store) {
    // No HandleContext - likely called outside of request
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[rsc-router] Handle "${name}" called outside of request context. ` +
          `Data will be lost. Make sure handles are called during server render.`
      );
    }
    return;
  }

  // Get segment ID from SegmentContext (supports concurrent execution)
  const segmentId = getCurrentSegment();
  if (!segmentId) {
    // No segment context - handle called in component body instead of handler/loader
    throw new Error(
      `[rsc-router] Handle "${name}" called outside of segment context. ` +
        `Handles must be called in handlers or loaders, not in component bodies. ` +
        `Move your handle call to a handler function or loader:\n\n` +
        `  // Option 1: Use handler function\n` +
        `  layout((ctx) => {\n` +
        `    ${name}({ ... });\n` +
        `    return <YourComponent />;\n` +
        `  }, ...)\n\n` +
        `  // Option 2: Use a loader\n` +
        `  loader(function ${name.charAt(0).toUpperCase() + name.slice(1)}Loader(ctx) {\n` +
        `    ${name}({ ... });\n` +
        `    return null;\n` +
        `  })`
    );
  }

  // Get or create entry for this handle
  let handleEntry = store.handles.get(name);
  if (!handleEntry) {
    handleEntry = {
      entries: new Map(),
    };
    store.handles.set(name, handleEntry);
  }

  // Get or create entries array for this segment
  let segmentEntries = handleEntry.entries.get(segmentId);
  if (!segmentEntries) {
    segmentEntries = [];
    handleEntry.entries.set(segmentId, segmentEntries);
  }

  // Resolve data (may be sync or async)
  const resolvedData =
    typeof data === "function"
      ? (data as () => unknown | Promise<unknown>)()
      : data;
  segmentEntries.push(resolvedData);

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[Handle] Pushed "${name}" data to segment ${segmentId}:`,
      resolvedData
    );
  }
}

/**
 * Per-segment handle data structure sent to client
 * Maps handleName -> segmentId -> resolved entries
 */
export type HandleDataBySegment = Record<string, Record<string, unknown[]>>;

/**
 * Resolve all handle data for the current request
 * Called after render to collect all data for RSC payload
 *
 * Waits for all tracked async handlers to complete before resolving.
 * Returns raw entries per segment - the client runs the reducer
 *
 * @returns Object mapping handle names to per-segment entries
 */
export async function resolveHandles(): Promise<HandleDataBySegment> {
  const store = getHandleStore();
  if (!store) {
    return {};
  }

  // Wait for all tracked async handlers to complete
  // This ensures all handle data has been pushed before we resolve
  await store.tracker.settled;

  const result: HandleDataBySegment = {};

  for (const [handleName, handleEntry] of store.handles) {
    const segmentData: Record<string, unknown[]> = {};

    for (const [segmentId, entries] of handleEntry.entries) {
      // Await all entries (some may be promises)
      const resolvedEntries = await Promise.all(entries);
      segmentData[segmentId] = resolvedEntries;
    }

    result[handleName] = segmentData;
  }

  return result;
}

/**
 * Server version of createHandle that pushes data to handle context.
 * This is selected via the react-server export condition.
 *
 * Server only needs the name - reducer/defaultValue are used on client.
 */
export function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  _reducer?: (acc: TAccumulated, next: TData) => TAccumulated,
  _defaultValue?: TAccumulated
): Handle<TData, TAccumulated> {
  // Server version: callable that pushes data by name
  const handle = ((data: TData | (() => TData | Promise<TData>)) => {
    pushHandleData(name, data);
  }) as Handle<TData, TAccumulated>;

  (handle as any).handleName = name;

  return handle;
}

// Register segment ID functions with the registry
// This runs when the server module is loaded
registerGetSegmentId(getCurrentSegment);
registerRunWithSegment(runWithSegment);
