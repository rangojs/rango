import { createLoader } from "@rangojs/router";
import { work } from "../prefetch-false-counts.js";

// The loaders of the /prefetch-false clientUrls() group
// (prefetch-false-client-urls.tsx). In a module of their own: the group is a
// "use client" module, and a loader module's exports become client stubs.

export const PfCuPriceLoader = createLoader((ctx) =>
  work(ctx, "cu/loader.price"),
);
export const PfCuReviewsLoader = createLoader((ctx) =>
  work(ctx, "cu/loader.data", 100),
);
export const PfCuBareLoader = createLoader((ctx) =>
  work(ctx, "cu/bare.data", 100),
);
export const PfCuItemLoader = createLoader((ctx) =>
  work(ctx, "cu/item.data", 100),
);
export const PfCuVtLoader = createLoader((ctx) => work(ctx, "cu/vt.data", 100));
