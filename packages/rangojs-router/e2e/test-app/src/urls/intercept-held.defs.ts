import { createHandle, createLoader } from "@rangojs/router";

// e2e/intercept-held.test.ts: an intercept slot whose loaders skip
// revalidate(), and handle pushes made inside an intercept slot.
// Module-level counters, so the page reads each run from the data and the
// test compares against what the modal showed when it opened.
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

// A loader that pushes a crumb and skips revalidate(), under a handler that
// pushes one too: an action from its modal re-runs the handler alone.
export const InterceptHeldPushLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)(`held-loader:${ctx.params.id}`);
  return { id: ctx.params.id };
});

// Writes of the index page's redirecting action (rango-t126). The index
// renders the count: the page under the intercept the redirect opens shows
// whether it was rendered again after the action.
let redirectWrites = 0;
export function bumpRedirectWrites(): void {
  redirectWrites += 1;
}
export function readRedirectWrites(): number {
  return redirectWrites;
}
