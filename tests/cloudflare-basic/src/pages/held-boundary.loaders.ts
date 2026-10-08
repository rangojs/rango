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
export const UlrLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { value: "ulr-loader-data" };
});
