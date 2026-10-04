/**
 * Background Task Runner
 *
 * Unified helper for scheduling async work via waitUntil, and the two bounded
 * waits the PPR shell capture puts on background work (raceDeadline,
 * settleGrowing). When waitUntil is unavailable, falls back to blocking or
 * skipping.
 */

interface WaitUntilHost {
  waitUntil?: (fn: () => Promise<void>) => void;
}

/**
 * Schedule an async task in the background via waitUntil.
 *
 * @param host - Object with optional waitUntil (request context or similar)
 * @param task - Async function to execute
 * @param blockWhenNoWaitUntil - If true, awaits the task when waitUntil is
 *   unavailable (e.g., Node.js dev server). If false (default), the task
 *   is silently skipped when waitUntil is unavailable.
 * @returns A promise when blocking fallback is used, void otherwise.
 */
export function runBackground(
  host: WaitUntilHost | null | undefined,
  task: () => Promise<void>,
  blockWhenNoWaitUntil = false,
): Promise<void> | void {
  if (host?.waitUntil) {
    host.waitUntil(task);
    return;
  }
  if (blockWhenNoWaitUntil) {
    return task();
  }
}

/**
 * Race `work` against an absolute deadline (epoch ms), keeping its value. The
 * losing work is not cancelled (a router match has no abort signal) and its
 * late rejection is swallowed. The timer is unref'd, so a pending deadline
 * never keeps a Node dev process alive.
 */
export async function raceDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<{ done: true; value: T } | { done: false }> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(
      () => resolve({ done: false }),
      Math.max(0, deadline - Date.now()),
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([
      work.then((value) => ({ done: true as const, value })),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait until every promise in `list` has settled, including ones appended
 * while waiting (a settled write can schedule a nested one: cacheRoute
 * schedules its store.set in a second waitUntil), or until `deadline` (epoch
 * ms). Resolves true when the list drained, false at the deadline. Never
 * mutates `list`: a later call waits for what is still pending.
 */
export async function settleGrowing(
  list: readonly Promise<unknown>[],
  deadline: number,
): Promise<boolean> {
  let seen = 0;
  while (list.length > seen) {
    if (Date.now() >= deadline) return false;
    const batch = list.slice(seen);
    seen = list.length;
    const settled = await raceDeadline(Promise.allSettled(batch), deadline);
    if (!settled.done) return false;
  }
  return true;
}
