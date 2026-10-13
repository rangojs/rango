import { createLoader } from "@rangojs/router";

// Loaders that fail on their rerun after an action (action-failure.test.ts):
// a clientUrls() group and its urls() twin. The page's `run` search param
// scopes the failure switch and the run counters, so parallel tests never
// share them.
const failing = new Map<string, true | "always">();
const runs = new Map<string, number>();

/** On: the throw loader throws once, or on every run while it stays on. */
export function setActionFailure(run: string, fail: boolean | "always"): void {
  if (fail) failing.set(run, fail);
  else failing.delete(run);
}

function nextRun(key: string): number {
  const next = (runs.get(key) ?? 0) + 1;
  runs.set(key, next);
  return next;
}

/**
 * Throws on its first run after its run's switch went on, and clears it.
 * Switched on "always", it throws on every run, as the refetch after
 * concurrent actions reruns it again. With `fail-first` in the URL it also
 * throws on its run's first run: a navigation that fails before any action.
 */
export const ActionFailureThrowLoader = createLoader(
  async (ctx): Promise<{ value: string }> => {
    const run = ctx.searchParams.get("run") ?? "none";
    const n = nextRun(`throw:${run}`);
    const fail = failing.get(run);
    if (fail || (n === 1 && ctx.searchParams.has("fail-first"))) {
      if (fail && fail !== "always") failing.delete(run);
      throw new Error(`stock service unavailable (run ${n})`);
    }
    return { value: `stock:${n}` };
  },
);

/**
 * Reruns with the throw loader and never fails. The page reads it outside
 * its error boundary, as that boundary's reset key: a later rerun clears the
 * error the throw loader left, in the render that brings its new data.
 */
export const ActionFailureRevisionLoader = createLoader(
  async (ctx): Promise<number> => {
    const run = ctx.searchParams.get("run") ?? "none";
    return nextRun(`revision:${run}`);
  },
);

export type ActionFailureResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/** Returns its run's failure as data. */
export const ActionFailureDataLoader = createLoader(
  async (ctx): Promise<ActionFailureResult> => {
    const run = ctx.searchParams.get("run") ?? "none";
    const n = nextRun(`data:${run}`);
    if (failing.has(run)) {
      return { ok: false, reason: `price service unavailable (run ${n})` };
    }
    return { ok: true, value: `price:${n}` };
  },
);
