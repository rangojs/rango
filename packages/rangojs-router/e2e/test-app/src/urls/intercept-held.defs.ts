import { createHandle, createLoader } from "@rangojs/router";

// Known-gap fixtures (e2e/intercept-held.test.ts): an intercept slot whose
// loaders all skip revalidate(), and handle pushes made inside an intercept
// slot. Module-level counters, so the page reads each run from the data and
// the test compares against what the modal showed when it opened.
export const InterceptHeldCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

let heldRuns = 0;
export const InterceptHeldLoader = createLoader(async () => {
  heldRuns += 1;
  return { runs: heldRuns };
});

// Control: the same modal with a loader that follows the default revalidation.
let rerunRuns = 0;
export const InterceptRerunLoader = createLoader(async () => {
  rerunRuns += 1;
  return { runs: rerunRuns };
});

export const InterceptPushLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)(`modal-loader:${ctx.params.id}`);
  return { id: ctx.params.id };
});
