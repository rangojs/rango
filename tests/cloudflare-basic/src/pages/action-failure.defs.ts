import { createLoader } from "@rangojs/router";

// Loaders that fail on their rerun after an action (e2e/action-failure.test.ts):
// a clientUrls() group and its urls() twin. The page's `run` search param
// scopes the failure switch and the run counters, so parallel tests never
// share them.
const failing = new Set<string>();
const runs = new Map<string, number>();

export function setActionFailure(run: string, fail: boolean): void {
  if (fail) failing.add(run);
  else failing.delete(run);
}

function nextRun(key: string): number {
  const next = (runs.get(key) ?? 0) + 1;
  runs.set(key, next);
  return next;
}

/** Throws while its run fails. */
export const ActionFailureThrowLoader = createLoader(
  async (ctx): Promise<{ value: string }> => {
    const run = ctx.searchParams.get("run") ?? "none";
    const n = nextRun(`throw:${run}`);
    if (failing.has(run)) {
      throw new Error(`stock service unavailable (run ${n})`);
    }
    return { value: `stock:${n}` };
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
