/**
 * Loaders and actions of the clientUrls-revalidate fixture group, outside its
 * "use client" module so the test reads the same instances.
 */
import { createLoader } from "../../../index.rsc.js";
import type { LoaderDefinition } from "../../../types.js";

export const runs: Record<string, number> = {};
export const ran = (name: string): number =>
  (runs[name] = (runs[name] ?? 0) + 1);
export const count = (name: string): number => runs[name] ?? 0;
export const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
};

type Counted = LoaderDefinition<{ value: string }>;

function counted(name: string): Counted {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

export const HeldLoader: Counted = counted("held");
export const ItemLoader: Counted = counted("item");
export const ResultLoader: Counted = counted("result");
export const ScopedLoader: Counted = counted("scoped");
export const ForcedLoader: Counted = counted("forced");
export const StaleLoader: Counted = counted("stale");
// revalidate(true) / revalidate(false) / no revalidate(), in the group and
// on a server route.
export const AlwaysLoader: Counted = counted("always");
export const NeverLoader: Counted = counted("never");
export const DefaultLoader: Counted = counted("default");
export const ServerAlwaysLoader: Counted = counted("server-always");
export const ServerNeverLoader: Counted = counted("server-never");
export const ServerDefaultLoader: Counted = counted("server-default");

export async function resultAction(ok: boolean): Promise<{ ok: boolean }> {
  return { ok };
}
export async function scopeAction(_form: FormData): Promise<void> {}

/** While true, FlakyLoader throws and FlakyDataLoader answers a failure. */
export const flaky = { failing: false };

export const FlakyLoader: LoaderDefinition<{ value: string }> = createLoader(
  async () => {
    ran("flaky");
    if (flaky.failing) throw new Error("stock service unavailable");
    return { value: "stock" };
  },
);

export type FlakyResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export const FlakyDataLoader: LoaderDefinition<FlakyResult> = createLoader(
  async (): Promise<FlakyResult> => {
    ran("flaky-data");
    return flaky.failing
      ? { ok: false, reason: "price service unavailable" }
      : { ok: true, value: "price" };
  },
);

export async function breakAction(): Promise<{ saved: boolean }> {
  flaky.failing = true;
  return { saved: true };
}
