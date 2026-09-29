import { cacheTag, createLoader } from "@rangojs/router";

// /loader-cache-tag (see urls.tsx). Tags are colon-free: the e2e invalidates
// them through /test/invalidate-tag/:tag.
export const BodyTaggedDepLoader = createLoader(async () => {
  cacheTag("loader-dep-tag");
  return { dep: crypto.randomUUID().slice(0, 8) };
});

// `loadedAt` is per run: an unchanged value is a HIT.
export const BodyTaggedLoader = createLoader(async (ctx) => {
  cacheTag("loader-body-tag");
  const { dep } = await ctx.use(BodyTaggedDepLoader);
  return {
    loadedAt: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    dep,
  };
});
