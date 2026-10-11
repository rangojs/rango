import { createLoader } from "@rangojs/router";

// History-cache handles (e2e history-cache-handles.test.ts). Page B's loader
// reruns on every visit, so a link back to B, which the history cache holds,
// is answered with part of the page re-rendered. Module-level run counter:
// the page shows each run, so the test knows the second visit re-ran it.
let tickRuns = 0;
export const HistoryHandlesTickLoader = createLoader(async () => {
  tickRuns += 1;
  return { runs: tickRuns };
});
