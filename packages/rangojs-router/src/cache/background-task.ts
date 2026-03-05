/**
 * Background Task Runner
 *
 * Unified helper for scheduling async work via waitUntil.
 * When waitUntil is unavailable, falls back to blocking or skipping.
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
