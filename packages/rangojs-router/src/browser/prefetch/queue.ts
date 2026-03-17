/**
 * Prefetch Queue
 *
 * Concurrency-limited FIFO queue for speculative prefetches (viewport/render).
 * Hover prefetches bypass this queue — they fire directly for immediate response
 * to user intent.
 *
 * Draining is deferred to the next animation frame so prefetch network activity
 * never blocks paint. This applies to both the initial batch and subsequent
 * batches — every drain cycle yields to the browser first.
 *
 * When a navigation starts, queued prefetches are cancelled but executing ones
 * are left running. Navigation can reuse their in-flight responses via the
 * prefetch cache's inflight promise map, avoiding duplicate requests.
 */

const MAX_CONCURRENT = 2;

const deferToNextPaint: (fn: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);

let active = 0;
const queue: Array<{
  key: string;
  execute: (signal: AbortSignal) => Promise<void>;
}> = [];
const queued = new Set<string>();
const executing = new Set<string>();
let abortController: AbortController | null = null;
let drainScheduled = false;

function startExecution(
  key: string,
  execute: (signal: AbortSignal) => Promise<void>,
): void {
  active++;
  executing.add(key);
  abortController ??= new AbortController();
  execute(abortController.signal).finally(() => {
    // Only decrement if this key wasn't already cleared by cancelAllPrefetches.
    // Without this guard, cancelled tasks' .finally() would underflow active
    // below zero, breaking the MAX_CONCURRENT guarantee.
    if (executing.delete(key)) {
      active--;
    }
    scheduleDrain();
  });
}

/**
 * Schedule a drain on the next animation frame.
 * Coalesces multiple drain requests into a single rAF callback so
 * batch completion doesn't schedule redundant frames.
 */
function scheduleDrain(): void {
  if (drainScheduled) return;
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  drainScheduled = true;
  deferToNextPaint(() => {
    drainScheduled = false;
    drain();
  });
}

function drain(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!;
    queued.delete(item.key);
    startExecution(item.key, item.execute);
  }
}

/**
 * Enqueue a prefetch for concurrency-limited execution.
 * Execution is always deferred to the next animation frame to avoid
 * blocking paint, even when below the concurrency limit.
 * Deduplicates by key — items already queued or executing are skipped.
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
 * Cancel queued prefetches. Executing prefetches are left running so
 * navigation can reuse their in-flight responses (checked via
 * consumeInflightPrefetch in the prefetch cache). With MAX_CONCURRENT=2
 * and priority: "low", in-flight prefetches don't meaningfully compete
 * with navigation fetches under HTTP/2 multiplexing.
 *
 * Called when a navigation starts via the NavigationProvider's
 * event controller subscription.
 */
export function cancelAllPrefetches(): void {
  queue.length = 0;
  queued.clear();
  drainScheduled = false;
}

/**
 * Hard-cancel everything including in-flight prefetches.
 * Used by clearPrefetchCache (server action invalidation) where
 * in-flight responses would be stale.
 */
export function abortAllPrefetches(): void {
  abortController?.abort();
  abortController = null;

  queue.length = 0;
  queued.clear();
  // Clear executing before resetting active. In-flight .finally() callbacks
  // check executing.delete(key) — if the key is gone, they skip decrementing,
  // so active settles at 0 without underflow.
  executing.clear();
  active = 0;
  drainScheduled = false;
}
