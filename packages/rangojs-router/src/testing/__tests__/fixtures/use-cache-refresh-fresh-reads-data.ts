// A "use cache" function for use-cache-refresh-fresh-reads.rsc-test.tsx
// (wrapped by rangoUseCacheTransform() in vitest.rsc.config.ts) whose stale
// refresh invalidates a tag, and the helper a cached loader shares with it.
import { revalidateTag } from "../../../cache/tag-invalidation.js";

export const refresh: {
  /** Body runs, per body. */
  runs: Record<string, number>;
  /** The refresh invalidates once this settles. */
  invalidateAfter: Promise<void> | undefined;
  /** Called once the refresh invalidated. */
  onInvalidated: () => void;
} = { runs: {}, invalidateAfter: undefined, onInvalidated: () => {} };

/** Counts a run of `body`; its second run, the refresh, invalidates. */
export async function runAndInvalidateOnRefresh(body: string): Promise<number> {
  const run = (refresh.runs[body] = (refresh.runs[body] ?? 0) + 1);
  if (run > 1) {
    if (refresh.invalidateAfter) {
      await refresh.invalidateAfter;
      // rsc/handler.ts marks the response sent in the microtasks after it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    revalidateTag("prices");
    refresh.onInvalidated();
  }
  return run;
}

/** Profile "stale" (ttl 0, swr 60). */
export async function getPrice(): Promise<string> {
  "use cache: stale";
  return `getPrice-${await runAndInvalidateOnRefresh("getPrice")}`;
}
