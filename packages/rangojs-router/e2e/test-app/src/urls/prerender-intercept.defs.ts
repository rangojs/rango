import { createLoader } from "@rangojs/router";

// e2e/prerender-intercept.test.ts: a modal loader whose revalidate() holds it
// across a server action, next to FreshTimestampLoader, which re-runs.
let heldRuns = 0;
export const PrerenderInterceptHeldLoader = createLoader(async () => {
  heldRuns += 1;
  return { runs: heldRuns };
});
