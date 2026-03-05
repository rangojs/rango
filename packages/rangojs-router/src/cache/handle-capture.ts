/**
 * Handle Capture
 *
 * Captures handle pushes during cached function execution.
 * Extracted from cache-runtime.ts so tests can import without
 * pulling in @vitejs/plugin-rsc/rsc dependencies.
 */

import type { HandleStore } from "../server/handle-store.js";
import type { SegmentHandleData } from "./types.js";

export interface HandleCapture {
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
    for (const capture of captures) {
      if (!capture.data[segmentId]) {
        capture.data[segmentId] = {};
      }
      if (!capture.data[segmentId][handleName]) {
        capture.data[segmentId][handleName] = [];
      }
      capture.data[segmentId][handleName].push(value);
    }
    originalPush(handleName, segmentId, value);
  };
}

/**
 * Start capturing handle pushes for a cached function execution.
 *
 * Concurrency-safe: multiple overlapping captures on the same
 * HandleStore are independent. Each capture registers a token in a
 * Set; stopping removes it. No ordering requirement (LIFO not needed).
 */
export function startHandleCapture(handleStore: HandleStore): {
  capture: HandleCapture;
  stop: () => void;
} {
  ensureInterceptorInstalled(handleStore);

  const capture: HandleCapture = { data: {} };
  const captures = activeCapturesMap.get(handleStore)!;
  captures.add(capture);

  return {
    capture,
    stop() {
      captures.delete(capture);
    },
  };
}
