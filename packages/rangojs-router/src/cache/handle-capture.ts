/**
 * Handle Capture
 *
 * Captures handle pushes during cached function execution.
 * Extracted from cache-runtime.ts so tests can import without
 * pulling in @vitejs/plugin-rsc/rsc dependencies.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentLoaderBodyId } from "../server/context.js";
import type { HandleStore } from "../server/handle-store.js";
import type { SegmentHandleData } from "./types.js";

/** Runs a callback in the async context a push was made in. */
export type PushContext = <T>(fn: () => T) => T;

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
   * fresh body's pushes belong only to the refreshed entry. A "use cache"
   * miss: it delivers a decoded copy of them (redeliverPushes).
   */
  divert?: boolean;
  /**
   * Also record each push's async context (`contexts`), so redeliverPushes
   * can make the push again where it was made.
   */
  keepContexts?: boolean;
  /**
   * Record key for an accepted push, in place of its segment id. A loader's
   * own cache() (loader-cache.ts recordOwnerKey) and "use cache"
   * (useCacheRecordKey) group pushes by the loader body that made them.
   */
  key?: () => string;
}

// The loader whose recorded push a "use cache" HIT is replaying
// (replayLoaderPush), for an enclosing "use cache" MISS's record key.
let replayingOwner: string | undefined;

/**
 * HandleStore.pushReplayed, attributed to `loaderId` for the record key of an
 * enclosing "use cache" MISS: an outer cached function records an inner HIT's
 * replayed loader pushes under that loader, not as its own.
 */
export function replayLoaderPush(
  handleStore: HandleStore,
  handleName: string,
  segmentId: string,
  value: unknown,
  loaderId: string,
): void {
  const prev = replayingOwner;
  replayingOwner = loaderId;
  try {
    handleStore.pushReplayed(handleName, segmentId, value, loaderId);
  } finally {
    replayingOwner = prev;
  }
}

/**
 * Record key for a "use cache" capture: run-length groups `${seq}:${owner}`,
 * so the HIT (handle-snapshot.ts appendHandles) delivers each loader's pushes
 * at most once per request. The owner is the loader whose body, entered
 * inside this execution via ctx.use, made the push; empty for the function's
 * own pushes and those of cached functions it calls. Groups keep push order
 * across owners. Create at call time: the caller's loader body is the
 * function's own scope.
 *
 * `replayed` collects the keys of groups that are an inner HIT's replay of a
 * loader's recorded pushes rather than that loader's run (a miss delivers
 * the two differently, deliverRecordedPushes). A group is one or the other.
 */
export function useCacheRecordKey(replayed?: Set<string>): () => string {
  const callerBody = getCurrentLoaderBodyId();
  let seq = 0;
  let last: string | undefined;
  return () => {
    const body = replayingOwner ?? getCurrentLoaderBodyId();
    const owner = body === callerBody ? "" : (body ?? "");
    const group = `${owner}:${replayingOwner !== undefined}`;
    if (group !== last) {
      last = group;
      seq++;
    }
    const key = `${seq}:${owner}`;
    if (replayingOwner !== undefined) replayed?.add(key);
    return key;
  };
}

export interface HandleCapture extends HandleCaptureOptions {
  data: Record<string, SegmentHandleData>;
  /**
   * With keepContexts: each recorded push's async context, index-aligned
   * with `data` (undefined where the runtime has no
   * AsyncLocalStorage.snapshot).
   */
  contexts?: Record<string, Record<string, (PushContext | undefined)[]>>;
  /** Start order: a capture starts after every capture enclosing it. */
  seq: number;
}

let nextCaptureSeq = 0;

// While a capture redelivers its pushes (redeliverPushes), the captures that
// started after it: they ran inside it and recorded the original pushes.
let redeliveringFrom: number | undefined;

const snapshotContext: (() => PushContext) | undefined =
  typeof AsyncLocalStorage.snapshot === "function"
    ? () => AsyncLocalStorage.snapshot() as PushContext
    : undefined;

/**
 * Run `deliver`, which pushes `capture`'s recorded values again (a "use
 * cache" miss's decoded copy), so that only the captures enclosing it record
 * them: a capture that started inside it, still active, already recorded the
 * original.
 */
export function redeliverPushes(
  capture: HandleCapture,
  deliver: () => void,
): void {
  const prev = redeliveringFrom;
  redeliveringFrom = capture.seq;
  try {
    deliver();
  } finally {
    redeliveringFrom = prev;
  }
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
    // Innermost first: the captures that accept one push are nested, and a
    // capture starts after the ones enclosing it. Past the innermost
    // diverting one, none records the push: that capture delivers it again
    // (a "use cache" miss's copy), or never to the page (a stale refresh),
    // and the enclosing captures see what reaches it.
    const from = redeliveringFrom;
    let diverted = false;
    if (captures.size === 1) {
      for (const capture of captures) diverted = record(capture);
    } else if (captures.size > 1) {
      const ordered = [...captures];
      for (let i = ordered.length - 1; i >= 0 && !diverted; i--) {
        diverted = record(ordered[i]!);
      }
    }
    if (diverted) {
      handleStore.assertOpen?.(handleName, segmentId);
    } else {
      originalPush(handleName, segmentId, value);
    }

    /** Records into `capture` when it accepts; true when it diverts. */
    function record(capture: HandleCapture): boolean {
      if (from !== undefined && capture.seq > from) return false;
      if (capture.accept && !capture.accept()) return false;
      const key = capture.key ? capture.key() : segmentId;
      ((capture.data[key] ??= {})[handleName] ??= []).push(value);
      if (capture.contexts) {
        ((capture.contexts[key] ??= {})[handleName] ??= []).push(
          snapshotContext?.(),
        );
      }
      return capture.divert === true;
    }
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

  const capture: HandleCapture = {
    data: {},
    ...options,
    contexts: options?.keepContexts ? {} : undefined,
    seq: nextCaptureSeq++,
  };
  const captures = activeCapturesMap.get(handleStore)!;
  captures.add(capture);

  return {
    capture,
    stop() {
      captures.delete(capture);
    },
  };
}
