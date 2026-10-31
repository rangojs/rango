import { createLoader } from "@rangojs/router";

// e2e/intercept-action-select.test.ts (rango-t200): the drawer's loader
// counts its runs, so the page shows whether an action from the open drawer
// re-ran it. Loaders only, so the client build gets id stubs for this module.
let drawerRuns = 0;
export const IasDrawerLoader = createLoader(async () => {
  drawerRuns += 1;
  return { runs: drawerRuns };
});
