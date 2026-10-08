import { createLoader } from "@rangojs/router";

export const ZlbLayoutLoader = createLoader(async () => {
  return { value: "layout-loader-data" };
});

export const ZlbSlotLoader = createLoader(async () => {
  return { value: "slot-loader-data" };
});

export const ZlbRouteLoader = createLoader(async () => {
  return { value: "route-loader-data" };
});

// Slow enough that a client navigation mounts its reader while the stream is
// still pending (use-loader-settled-read e2e).
// The run number tells a test which navigation's value is on screen.
let settledReadRuns = 0;
export const SettledReadLoader = createLoader(async () => {
  const run = ++settledReadRuns;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { value: `settled-read-run-${run}` };
});
