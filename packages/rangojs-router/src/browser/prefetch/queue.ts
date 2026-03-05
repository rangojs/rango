/**
 * Prefetch Queue
 *
 * Concurrency-limited FIFO queue for speculative prefetches (viewport/render).
 * Hover prefetches bypass this queue — they fire directly for immediate response
 * to user intent.
 *
 * All queued/executing prefetches share a single AbortController so they can
 * be cancelled in bulk when a navigation starts.
 */

const MAX_CONCURRENT = 2;

let active = 0;
const queue: Array<{
  key: string;
  execute: (signal: AbortSignal) => Promise<void>;
}> = [];
const queued = new Set<string>();
const executing = new Set<string>();
let abortController: AbortController | null = null;

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
 * If below the concurrency limit, executes immediately.
 * Otherwise queues for later execution.
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

  if (active < MAX_CONCURRENT) {
    startExecution(key, execute);
  } else {
    queued.add(key);
    queue.push({ key, execute });
  }
}

/**
 * Cancel all in-flight and queued prefetches.
 * Called when a navigation starts — speculative prefetches should not
 * compete with navigation fetches for connection slots.
 */
export function cancelAllPrefetches(): void {
  abortController?.abort();
  abortController = null;

  queue.length = 0;
  queued.clear();
  // Clear executing before resetting active. In-flight .finally() callbacks
  // check executing.delete(key) — if the key is gone, they skip decrementing,
  // so active settles at 0 without underflow.
  executing.clear();
  active = 0;
}
