import { createLoader } from "@rangojs/router";

/**
 * Consumer-app chrome mirror (workerd variant): three UNFLAGGED layout-level
 * loaders streaming above a clientUrls include while the route's flagged
 * loader is awaited. See tests/vite-rsc-demo chrome-fixture.ts for the node
 * twin and the "inner boundary shows its fallback with pure-sync content"
 * report this exists to reproduce.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const MirrorSessionLoader = createLoader(async () => {
  await sleep(400);
  return { user: "guest" };
});

export const MirrorBasketLoader = createLoader(async () => {
  await sleep(800);
  return { items: 2 };
});

export const MirrorVehicleLoader = createLoader(async () => {
  await sleep(1200);
  return { rego: null as string | null };
});

export const MirrorPlpLoader = createLoader(
  async (ctx): Promise<{ slug: string; marker: string }> => {
    await sleep(300);
    return {
      slug: ctx.params.slug ?? "missing",
      marker: "mirror-awaited-data",
    };
  },
);
