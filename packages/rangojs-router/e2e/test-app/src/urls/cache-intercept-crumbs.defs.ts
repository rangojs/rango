import { createLoader } from "@rangojs/router";
import { InterceptHeldCrumbs } from "./intercept-held.defs.js";

// e2e/cache.test.ts "cache-intercept-routes": declared by the detail route
// and by its intercept (rango-t184).
export const CacheInterceptSharedLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)("shared-loader");
  return { ok: true };
});
