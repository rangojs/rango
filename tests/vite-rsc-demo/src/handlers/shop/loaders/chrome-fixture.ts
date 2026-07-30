import { createLoader } from "@rangojs/router";

/**
 * Consumer-app chrome mirror: three UNFLAGGED layout-level loaders registered
 * on the layout that wraps the clientUrls include (session/basket/vehicle in
 * the source app). They stream on every document render — their pending
 * promises ride the LAYOUT segment's loaderStreams while the route's flagged
 * loader is awaited. Fixture for the "inner boundary shows its fallback with
 * pure-sync content" report.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DemoSessionLoader = createLoader(async () => {
  "use server";
  await sleep(400);
  return { user: "guest" };
});

export const DemoBasketLoader = createLoader(async () => {
  "use server";
  await sleep(800);
  return { items: 2 };
});

export const DemoVehicleLoader = createLoader(async () => {
  "use server";
  await sleep(1200);
  return { rego: null as string | null };
});
