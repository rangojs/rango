/**
 * Handle Capture
 *
 * Captures handle pushes during cached function execution.
 * Extracted from cache-runtime.ts so tests can import without
 * pulling in @vitejs/plugin-rsc/rsc dependencies.
 */

import type { HandleStore } from "../server/handle-store.js";
import type { SegmentHandleData } from "./types.js";

/**
 * Scoping for one capture of a cached unit (a loader's own cache(),
 * loader-cache.ts; a "use cache" function, cache-runtime.ts) that runs
 * concurrently with live pushes into the same store.
 */
export interface HandleCaptureOptions {
  /** Push-time predicate; a rejected push is not recorded by this capture. */
  accept?: () => boolean;
  /**
   * Recorded pushes do not reach the store. A stale hit's background
   * revalidation: the foreground already replayed the entry's pushes, so the
   * fresh body's pushes belong only to the refreshed entry.
   */
  divert?: boolean;
  /**
   * Record key for an accepted push, in place of its segment id. A loader's
   * own cache() groups pushes by the loader body that made them.
   */
  key?: () => string;
}

export interface HandleCapture extends HandleCaptureOptions {
  data: Record<string, SegmentHandleData>;
}

/**
 * Active capture tokens per HandleStore.
 *
 * Instead of mutating handleStore.push (which breaks when overlapping
 * captures finish out of order), we install a single interceptor on
 * first use and manage a set of active capture tokens. Each push fans
 * out to every active token. Stopping a capture simply removes the
 * token — order does not matter.
 */
const activeCapturesMap = new WeakMap<HandleStore, Set<HandleCapture>>();

/**
 * One-time interceptor installation. Wraps the original push so every
 * call fans out to all active capture tokens. Installed once per
 * HandleStore instance; subsequent startHandleCapture calls on the
 * same store just add tokens to the Set.
 */
function ensureInterceptorInstalled(handleStore: HandleStore): void {
  if (activeCapturesMap.has(handleStore)) return;

  const captures = new Set<HandleCapture>();
  activeCapturesMap.set(handleStore, captures);

  const originalPush = handleStore.push.bind(handleStore);
  handleStore.push = (
    handleName: string,
    segmentId: string,
    value: unknown,
  ) => {
    let diverted = false;
    for (const capture of captures) {
      if (capture.accept && !capture.accept()) continue;
      if (capture.divert) diverted = true;
      const key = capture.key ? capture.key() : segmentId;
      if (!capture.data[key]) {
        capture.data[key] = {};
      }
      if (!capture.data[key][handleName]) {
        capture.data[key][handleName] = [];
      }
      capture.data[key][handleName].push(value);
    }
    if (!diverted) originalPush(handleName, segmentId, value);
  };
}

/**
 * Start capturing handle pushes for a cached function or cached loader
 * execution (`options`: see HandleCaptureOptions).
 *
 * Concurrency-safe: multiple overlapping captures on the same
 * HandleStore are independent. Each capture registers a token in a
 * Set; stopping removes it. No ordering requirement (LIFO not needed).
 */
export function startHandleCapture(
  handleStore: HandleStore,
  options?: HandleCaptureOptions,
): {
  capture: HandleCapture;
  stop: () => void;
} {
  ensureInterceptorInstalled(handleStore);

  const capture: HandleCapture = { data: {}, ...options };
  const captures = activeCapturesMap.get(handleStore)!;
  captures.add(capture);

  return {
    capture,
    stop() {
      captures.delete(capture);
    },
  };
}
