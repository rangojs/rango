import { createLoader } from "@rangojs/router";

// e2e/parallel-loader-inherit.test.ts: the route's loader, read from a child
// layout's parallel slot. Its run count shows the loader held across an
// action and a same-route navigation.
let runs = 0;
export const ParallelInheritRunsLoader = createLoader(async () => {
  runs += 1;
  return { runs };
});
