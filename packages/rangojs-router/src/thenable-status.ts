/**
 * Thenable statuses React's `use()` unwraps without suspending: React's
 * re-check after `.then()` handles "fulfilled", and Flight chunks in the
 * resolved_* states initialize synchronously inside that same call. Anything
 * else (pending, blocked, an unstamped native promise) suspends at least once.
 * Shared by the dev SSR-suspension diagnostic and the held-navigation
 * isLoading registration (loader-store.ts), which must agree on "settled".
 */
export function unwrapsSynchronously(stream: Promise<unknown>): boolean {
  const status = (stream as { status?: string }).status;
  return (
    status === "fulfilled" ||
    status === "resolved_model" ||
    status === "resolved_module"
  );
}

/**
 * A resolved thenable for a use() whose result is ignored: React reads the
 * "fulfilled" stamp and returns at once. `_debugInfo` keeps React DevTools from
 * listing a 0 ms promise on every reader that calls it.
 */
export const SETTLED_THENABLE: Promise<undefined> = Object.assign(
  Promise.resolve(undefined),
  { status: "fulfilled", value: undefined, _debugInfo: [] },
);

/**
 * The value React reads from `value` without suspending: `value` itself when
 * it is not a promise, a promise's `value` once it carries React's or Flight's
 * `status: "fulfilled"`. Undefined while it is pending or rejected.
 */
export function settledValue<T>(value: T | Promise<T>): T | undefined {
  if (!(value instanceof Promise)) return value;
  const thenable = value as Promise<T> & { status?: string; value?: T };
  return thenable.status === "fulfilled" ? thenable.value : undefined;
}
