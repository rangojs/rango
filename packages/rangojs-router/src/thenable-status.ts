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
