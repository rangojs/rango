/**
 * Shared thenable predicate for framework orchestration. It decides which values
 * participate in promise lifecycles and which pass through synchronously.
 *
 * Requires a CALLABLE `then` (`typeof obj.then === "function"`), not merely a
 * `"then" in obj` membership check, so a non-promise carrying a `then` field
 * (e.g. a serialized shape `{ then: 5 }`) is treated as a plain sync value rather
 * than awaited. A single predicate keeps that classification consistent.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
