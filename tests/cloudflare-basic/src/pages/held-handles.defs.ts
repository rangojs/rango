import { createHandle, createLoader, Meta } from "@rangojs/router";

// Held-loader handle pushes (#1103, e2e held-handles.test.ts). Two loaders on
// one route push into the same segment's handle buckets. An unrelated action
// skips the held loader's rerun (its revalidate() answers false) and reruns
// the other one: the held loader's title and crumb must stay, and the rerun
// loader's crumb must be replaced, not doubled. Module-level run counters, so
// the page reads each loader's run from its data and the test compares the
// pushes with it instead of with absolute numbers.
export const HeldCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

let heldRuns = 0;
export const HeldHandlesHeldLoader = createLoader(async (ctx) => {
  heldRuns += 1;
  const runs = heldRuns;
  ctx.use(Meta)({ title: `Held handles ${runs}` });
  ctx.use(HeldCrumbs)(`held:${runs}`);
  return { runs };
});

let rerunRuns = 0;
export const HeldHandlesRerunLoader = createLoader(async (ctx) => {
  rerunRuns += 1;
  const runs = rerunRuns;
  ctx.use(HeldCrumbs)(`rerun:${runs}`);
  return { runs };
});
