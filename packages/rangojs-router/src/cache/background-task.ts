/**
 * Background Task Runner
 *
 * Unified helper for scheduling async work via waitUntil, and the two bounded
 * waits the PPR shell capture puts on background work (raceDeadline,
 * settleGrowing). When waitUntil is unavailable, falls back to blocking or
 * skipping.
 */

import type { ExecutionContext } from "../types/request-scope.js";

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

/** Macrotask turns `awaitLaterMillisecond` waits at most. */
export const LATER_MILLISECOND_MAX_TURNS = 10;

/**
 * Yield until `Date.now()` passes `since`, so a store's whole-millisecond tag
 * gate (putShell vs an invalidation made just before) sees a later
 * millisecond. Bounded: on Cloudflare the clock stands still between I/O
 * events, so an unbounded wait could hang. At the bound the caller proceeds
 * and a store may refuse the write, which its result reports.
 */
export async function awaitLaterMillisecond(
  since: number,
  maxTurns: number = LATER_MILLISECOND_MAX_TURNS,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && Date.now() === since; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** An ExecutionContext that keeps every promise handed to `waitUntil`. */
export interface CollectingExecutionContext extends ExecutionContext {
  readonly tasks: Promise<unknown>[];
}

/**
 * Wrap the caller's ExecutionContext (or none) so a caller can wait for the
 * request's background work: the deferred cache writes, the shell capture, a
 * store's own writes. Every other member reads through to `inner`, bound to
 * it (workerd's methods reject a foreign `this`).
 */
export function createCollectingExecutionContext(
  inner?: ExecutionContext,
): CollectingExecutionContext {
  const tasks: Promise<unknown>[] = [];
  const own: CollectingExecutionContext = {
    tasks,
    waitUntil(promise) {
      const task = Promise.resolve(promise);
      // The list only waits; the host (or the log below) owns the failure.
      tasks.push(task.catch(() => {}));
      if (inner) inner.waitUntil(task);
      else {
        task.catch((error) =>
          console.error("[waitUntil] Background task failed:", error),
        );
      }
    },
    passThroughOnException() {},
  };
  if (!inner) return own;
  return new Proxy(own, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      const value = (inner as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}
