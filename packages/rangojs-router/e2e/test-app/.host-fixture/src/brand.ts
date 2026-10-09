import { createLoader, createVar } from "@rangojs/router";

// Each app's middleware sets its own brand, and both apps mount this one
// loader with cache(). With the hostOverride cookie both serve the same host
// and path, so the cached value has to be the serving router's (issue #1065).
export const Brand = createVar<string>();

export const BrandLoader = createLoader(async (ctx) => ({
  brand: ctx.get(Brand) ?? "none",
}));
