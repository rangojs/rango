// A "use cache" function for prefetch-false.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts), read by a flagged loader
// and by a handler behind a flagged loading().

/** Runs of the function's body, per key. */
export const runs: Record<string, number> = {};

export async function ratingsFor(key: string): Promise<string> {
  "use cache";
  runs[key] = (runs[key] ?? 0) + 1;
  return `${key}-ratings-${runs[key]}`;
}
