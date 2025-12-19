/**
 * Registry for segment ID functions
 *
 * This allows code to interact with segment ID context without
 * directly importing from handle-context.ts (which has node:async_hooks).
 *
 * The server registers the real functions, client leaves them as null.
 */

let getSegmentIdFn: (() => string | null) | null = null;
let runWithSegmentFn: (<T>(segmentId: string, callback: () => T) => T) | null =
  null;

/**
 * Register the segment ID getter (called by server code)
 */
export function registerGetSegmentId(fn: () => string | null): void {
  getSegmentIdFn = fn;
}

/**
 * Register the runWithSegment function (called by server code)
 * This is the preferred way to set segment ID for concurrent execution.
 */
export function registerRunWithSegment(
  fn: <T>(segmentId: string, callback: () => T) => T
): void {
  runWithSegmentFn = fn;
}

/**
 * Run a callback with a specific segment ID context.
 * Creates an isolated execution context for concurrent execution support.
 * Falls back to just calling the callback if not on server.
 */
export function runWithSegmentIfAvailable<T>(
  segmentId: string,
  callback: () => T
): T {
  if (runWithSegmentFn) {
    return runWithSegmentFn(segmentId, callback);
  }
  return callback();
}

/**
 * Get the current segment ID if the getter is registered
 * Returns null on client
 */
export function getCurrentSegmentId(): string | null {
  return getSegmentIdFn ? getSegmentIdFn() : null;
}
