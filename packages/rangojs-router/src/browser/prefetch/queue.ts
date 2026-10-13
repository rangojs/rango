/**
 * Prefetch Queue
 *
 * Concurrency-limited FIFO queue for speculative prefetches (viewport/render).
 * Hover prefetches bypass this queue — they fire directly for immediate response
 * to user intent.
 *
 * Draining waits for an idle main-thread moment and for viewport images to
 * finish loading, so prefetch fetch() calls never compete with critical
 * resources for the browser's connection pool.
 *
 * When a navigation starts, queued prefetches are cancelled but executing ones
 * are left running. Navigation can reuse their in-flight responses via the
 * prefetch cache's inflight promise map, avoiding duplicate requests.
 */

import { wait, waitForIdle, waitForViewportImages } from "./resource-ready.js";

// Max prefetches executing at once. Mirrors DEFAULT_PREFETCH_CONCURRENCY
// (router/prefetch-limits.ts); kept as a local literal so the client bundle
// doesn't pull in router-layer code. Overridden at startup by
// setPrefetchConcurrency from server metadata.
let maxConcurrent = 2;
const IMAGE_WAIT_TIMEOUT = 2000;

/**
 * Set the max number of concurrently-executing speculative prefetches.
 * Called once at app startup with the value from server metadata. A value
 * below 1 (or non-finite) is ignored, keeping the default.
 */
export function setPrefetchConcurrency(n: number): void {
  if (Number.isFinite(n) && n >= 1) {
    maxConcurrent = Math.floor(n);
  }
}

let active = 0;
const queue: Array<{
  key: string;
  execute: (signal: AbortSignal) => Promise<void>;
}> = [];
const queued = new Set<string>();
const executing = new Set<string>();
const abortControllers = new Map<string, AbortController>();
let drainScheduled = false;
let drainGeneration = 0;

function startExecution(
  key: string,
  execute: (signal: AbortSignal) => Promise<void>,
): void {
  active++;
  executing.add(key);
  const ac = new AbortController();
  abortControllers.set(key, ac);
  execute(ac.signal).finally(() => {
    abortControllers.delete(key);
    // Only decrement if this key wasn't already cleared by cancelAllPrefetches.
    // Without this guard, cancelled tasks' .finally() would underflow active
    // below zero, breaking the maxConcurrent guarantee.
    if (executing.delete(key)) {
      active--;
    }
    scheduleDrain();
  });
}

/**
 * Schedule a drain after the browser is idle and viewport images are loaded.
 * Coalesces multiple drain requests into a single deferred callback so
 * batch completion doesn't schedule redundant waits.
 *
 * The two-step wait ensures prefetch fetch() calls don't compete with
 * images for the browser's connection pool:
 * 1. waitForIdle — yield until the main thread has a quiet moment
 * 2. waitForViewportImages OR 2s timeout — yield until visible images
 *    finish loading, but don't let slow/broken images block indefinitely
 */
function scheduleDrain(): void {
  if (drainScheduled) return;
  if (active >= maxConcurrent || queue.length === 0) return;
  drainScheduled = true;
  const gen = drainGeneration;
  waitForIdle()
    .then(() =>
      Promise.race([waitForViewportImages(), wait(IMAGE_WAIT_TIMEOUT)]),
    )
    .then(() => {
      // Stale drain: a cancel/abort happened while we were waiting, and a fresh
      // scheduleDrain may already own drainScheduled for the new generation.
      // Bail WITHOUT clearing the flag so we don't clobber the live wait's
      // single-in-flight-drain coalescing (clearing it here would let the next
      // enqueue start a third overlapping wait).
      if (gen !== drainGeneration) return;
      drainScheduled = false;
      if (queue.length > 0) drain();
    });
}

function drain(): void {
  while (active < maxConcurrent && queue.length > 0) {
    const item = queue.shift()!;
    queued.delete(item.key);
    startExecution(item.key, item.execute);
  }
}

/**
 * Enqueue a prefetch for concurrency-limited execution.
 * Execution is deferred until the browser is idle and viewport images
 * have finished loading, so prefetches never compete with critical
 * resources. Deduplicates by key — items already queued or executing
 * are skipped.
 *
 * The executor receives an AbortSignal that is aborted when
 * cancelAllPrefetches() is called (e.g. on navigation start).
 */
export function enqueuePrefetch(
  key: string,
  execute: (signal: AbortSignal) => Promise<void>,
): void {
  if (queued.has(key) || executing.has(key)) return;

  queued.add(key);
  queue.push({ key, execute });
  scheduleDrain();
}

/**
 * Normalize a URL-like string for keep-alive matching: parse against a
 * placeholder origin and strip internal `_rsc_*` query params. Returns
 * `pathname + search` so comparisons ignore hash and the internal params
 * that prefetch appends to targets (`_rsc_partial`, `_rsc_segments`,
 * `_rsc_v`, `_rsc_rid`, `_rsc_stale`).
 */
function normalizeForMatch(urlish: string): string {
  try {
    const u = new URL(urlish, "http://placeholder");
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith("_rsc_")) u.searchParams.delete(k);
    }
    return u.pathname + u.search;
  } catch {
    return urlish;
  }
}

/**
 * Cancel queued prefetches and abort in-flight ones that don't match
 * the current navigation target. If `keepUrl` is provided, the
 * executing prefetch whose key targets that URL is kept alive so
 * navigation can reuse its response via consumeInflightPrefetch.
 *
 * Called when a navigation starts via the NavigationProvider's
 * event controller subscription.
 */
export function cancelAllPrefetches(keepUrl?: string | null): void {
  queue.length = 0;
  queued.clear();
  drainScheduled = false;
  drainGeneration++;

  // Abort in-flight prefetches that aren't for the navigation target.
  // Key shapes (see prefetch/cache.ts buildPrefetchKey):
  //   wildcard:      "rangoState\0/target?..."
  //   source-scoped: "rangoState\0sourceHref\0/target?..."
  // The target portion is always the final \0-delimited segment and
  // includes internal `_rsc_*` params (from buildPrefetchUrl); keepUrl
  // comes from NavigationProvider's pendingUrl which is the bare
  // navigation target. Normalize both sides before comparing.
  const normalizedKeep = keepUrl ? normalizeForMatch(keepUrl) : null;
  for (const [key, ac] of abortControllers) {
    const lastNul = key.lastIndexOf("\0");
    const target = lastNul >= 0 ? key.substring(lastNul + 1) : "";
    if (
      normalizedKeep &&
      target &&
      normalizeForMatch(target) === normalizedKeep
    )
      continue;
    ac.abort();
    abortControllers.delete(key);
    if (executing.delete(key)) {
      active--;
    }
  }
}

/**
 * Hard-cancel everything including in-flight prefetches.
 * Used by clearPrefetchCache (server action invalidation) where
 * in-flight responses would be stale.
 */
export function abortAllPrefetches(): void {
  for (const ac of abortControllers.values()) {
    ac.abort();
  }
  abortControllers.clear();

  queue.length = 0;
  queued.clear();
  // Clear executing before resetting active. In-flight .finally() callbacks
  // check executing.delete(key) — if the key is gone, they skip decrementing,
  // so active settles at 0 without underflow.
  executing.clear();
  active = 0;
  drainScheduled = false;
  drainGeneration++;
}
