// Loaders and run counters of the clientUrls() group in
// prefetch-false-client-urls.tsx, read by prefetch-false-client-urls.rsc-test.tsx.
// In a module of their own: the group is a "use client" module.
import { createLoader, type LoaderDefinition } from "../../../index.rsc.js";

export const runs: Record<string, number> = {};

/** Count one run of `name`; returns the run number. */
export const ran = (name: string): number =>
  (runs[name] = (runs[name] ?? 0) + 1);

export const count = (name: string): number => runs[name] ?? 0;

export const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
};

function counted(name: string): LoaderDefinition<{ value: string }> {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

export const PriceLoader: LoaderDefinition<{ value: string }> =
  counted("price");
export const ReviewsLoader: LoaderDefinition<{ value: string }> =
  counted("reviews");
export const ItemLoader: LoaderDefinition<{ value: string }> = counted("item");
export const ShellLoader: LoaderDefinition<{ value: string }> =
  counted("cu-shell");
export const DetailLoader: LoaderDefinition<{ value: string }> =
  counted("detail");
export const ModalLoader: LoaderDefinition<{ value: string }> =
  counted("modal");
export const NoteLoader: LoaderDefinition<{ value: string }> = counted("note");
