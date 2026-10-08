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
