/**
 * Test-only run counters for the /prefetch-false fixture
 * (urls/prefetch-false.tsx), read back by /prefetch-false/__counts so a suite
 * proves on the server that flagged work did not run for a prefetch and ran
 * once for the click. Keyed by the `?run=` every request of one test carries,
 * so parallel tests and retries never share a counter. Bounded: the oldest
 * runs drop.
 */
const MAX_RUNS = 500;
const runs = new Map<string, Map<string, number>>();

export function countRun(run: string, name: string): number {
  let counts = runs.get(run);
  if (!counts) {
    counts = new Map();
    runs.set(run, counts);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  }
  const next = (counts.get(name) ?? 0) + 1;
  counts.set(name, next);
  return next;
}

export function readRunCounts(run: string): Record<string, number> {
  return Object.fromEntries(runs.get(run) ?? []);
}

/** The `?run=` of the request: the counters' key. */
export const runOf = (ctx: any): string => ctx.searchParams.get("run") ?? "";

/** `&delay=<ms>`: added to every `.data` and `.early` loader. */
export const delayOf = (ctx: any): number =>
  Number(ctx.searchParams.get("delay") ?? 0) || 0;

/**
 * Count one run of `name` and take `delayMs`. A `.data` or `.early` counter
 * also takes `&delay=` and, with `&slow=1`, 600 ms more.
 */
export async function work(
  ctx: any,
  name: string,
  delayMs: number = 0,
): Promise<{ name: string; n: number }> {
  const n = countRun(runOf(ctx), name);
  const timed = name.endsWith(".data") || name.endsWith(".early");
  const slow = timed && ctx.searchParams.get("slow") === "1";
  const wait = delayMs + (slow ? 600 : 0) + (timed ? delayOf(ctx) : 0);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return { name, n };
}
