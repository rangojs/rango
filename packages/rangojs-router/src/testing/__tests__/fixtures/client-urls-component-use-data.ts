/**
 * Loaders and actions of the Component.use fixture
 * (client-urls-component-use*.tsx), outside its "use client" modules so the
 * test reads the same instances.
 */
import { createLoader } from "../../../index.rsc.js";
import type { LoaderDefinition } from "../../../types.js";

export const runs: Record<string, number> = {};
const ran = (name: string): number => (runs[name] = (runs[name] ?? 0) + 1);
export const count = (name: string): number => runs[name] ?? 0;
export const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
};

type Counted = LoaderDefinition<{ value: string }>;

function counted(name: string): Counted {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

/** The page component's `.use` loader, with a revalidate() predicate. */
export const StatsLoader: Counted = counted("stats");
/** The layout component's `.use` loader, on the default rules. */
export const CartLoader: Counted = counted("cart");

export async function bumpStats(): Promise<{ ok: boolean }> {
  return { ok: true };
}
export async function otherAction(): Promise<{ ok: boolean }> {
  return { ok: true };
}
