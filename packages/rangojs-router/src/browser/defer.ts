/**
 * A promise and the function that resolves it. Never rejected: a hole of a
 * `prefetch: false` adoption is resolved by its fill or released
 * (browser/partial-update.ts releaseHoles).
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise resolved from outside. */
export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
