/**
 * Loaders and the action of the clientUrls-layout-revalidate fixture group,
 * outside its "use client" module so the test reads the same instances.
 */
import { createLoader } from "../../../index.rsc.js";
import type { LoaderDefinition } from "../../../types.js";

export const runs: Record<string, number> = {};
export const count = (name: string): number => runs[name] ?? 0;
/** The `defaultShouldRevalidate` each run of SeenLoader's predicate got. */
export const seenDefaults: boolean[] = [];
export const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
  seenDefaults.length = 0;
};

/** SeenLoader's predicate: records the default and defers to it. */
export function recordDefault(defaultShouldRevalidate: boolean): undefined {
  seenDefaults.push(defaultShouldRevalidate);
  return undefined;
}

type Counted = LoaderDefinition<{ value: string }>;

function counted(name: string): Counted {
  return createLoader(async () => {
    runs[name] = count(name) + 1;
    return { value: `${name}-run-${runs[name]}` };
  });
}

export const HeldLoader: Counted = counted("held");
export const ActionLoader: Counted = counted("action");
export const ForcedLoader: Counted = counted("forced");
export const DefaultLoader: Counted = counted("default");
export const ParamsLoader: Counted = counted("params");
export const SeenLoader: Counted = counted("seen");
export const ItemLoader: Counted = counted("item");
export const FlaggedLoader: Counted = counted("flagged");
export const FlaggedDefaultLoader: Counted = counted("flagged-default");

export async function bumpAction(): Promise<void> {}
