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
