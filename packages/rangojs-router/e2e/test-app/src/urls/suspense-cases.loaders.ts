import { createLoader } from "@rangojs/router";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Each value carries its run count: a test tells a re-run from a held value.
let shellRuns = 0;
let itemRuns = 0;
let aRuns = 0;
let bRuns = 0;
let slowRuns = 0;
let liveRuns = 0;

export const ScShellLoader = createLoader(async () => {
  await wait(30);
  return { value: `shell-${++shellRuns}` };
});

export const ScItemLoader = createLoader(async (ctx) => {
  await wait(200);
  const id = ctx.params.id ?? ctx.params.n;
  return { value: `item-${id}-${++itemRuns}` };
});

export const ScALoader = createLoader(async () => {
  await wait(100);
  return { value: `a-${++aRuns}` };
});

export const ScBLoader = createLoader(async () => {
  await wait(100);
  return { value: `b-${++bRuns}` };
});

export const ScSlowLoader = createLoader(async () => {
  await wait(700);
  return { value: `slow-${++slowRuns}` };
});

// Fetchable: its reader refetches it in place with useLoader().load().
export const ScLiveLoader = createLoader(async () => {
  await wait(50);
  return { value: `live-${++liveRuns}` };
}, true);
