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

export async function resultAction(ok: boolean): Promise<{ ok: boolean }> {
  return { ok };
}
export async function scopeAction(_form: FormData): Promise<void> {}
