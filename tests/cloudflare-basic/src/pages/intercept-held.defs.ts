import { createHandle, createLoader } from "@rangojs/router";

// Intercept slot loaders and handle pushes (e2e intercept-held.test.ts,
// mirrors the router e2e app's intercept-held fixture). Module-level run
// counters, so the page reads each run from the data and the test compares
// against what the modal showed when it opened.
export const InterceptHeldCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

let heldRuns = 0;
export const InterceptHeldLoader = createLoader(async () => {
  heldRuns += 1;
  return { runs: heldRuns };
});

// A loader that follows the default revalidation.
let rerunRuns = 0;
export const InterceptRerunLoader = createLoader(async () => {
  rerunRuns += 1;
  return { runs: rerunRuns };
});

export const InterceptPushLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)(`modal-loader:${ctx.params.id}`);
  return { id: ctx.params.id };
});

// A loader that pushes a crumb and skips revalidate(), under a handler that
// pushes one too: an action from its modal re-runs the handler alone.
export const InterceptHeldPushLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)(`held-loader:${ctx.params.id}`);
  return { id: ctx.params.id };
});
