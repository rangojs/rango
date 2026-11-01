import { createHandle, createLoader } from "@rangojs/router";
import { InterceptHeldCrumbs } from "./intercept-held.defs.js";

// e2e/cache.test.ts "cache-intercept-routes": the layout's render stamp,
// which its handler pushes, so the stamp crumb shows which render a HIT that
// holds the layout left on screen.
export const CacheInterceptLayoutStamp = createHandle<string, string[]>(
  (segments) => segments.flat(),
);

// e2e/cache.test.ts "cache-intercept-routes": declared by the detail route
// and by its intercept.
export const CacheInterceptSharedLoader = createLoader(async (ctx) => {
  ctx.use(InterceptHeldCrumbs)("shared-loader");
  return { ok: true };
});
