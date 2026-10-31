import { createLoader } from "@rangojs/router";

// e2e/cache.test.ts (rango-t200): the drawer's loader counts its runs, so the
// page shows whether an action from the open drawer re-ran it.
let drawerRuns = 0;
export const CiwDrawerLoader = createLoader(async () => {
  drawerRuns += 1;
  return { runs: drawerRuns };
});
