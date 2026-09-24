import { createLoader } from "@rangojs/router";
import { DepCrumbs } from "../handles/dep-crumbs.js";

// /loader-cache-dep: the dependency of a loader with its own cache(), also
// read by an uncached sibling loader. Each run pushes one crumb with a per-run
// id, so a live run's crumb differs from the cached one.
export const DepCrumbCategoryLoader = createLoader(async (ctx) => {
  ctx.use(DepCrumbs)(`Category ${crypto.randomUUID().slice(0, 8)}`);
  return { slug: "category" };
});

// Cached (the route binds it with cache()); awaits the dependency.
export const DepCrumbProductLoader = createLoader(async (ctx) => {
  const { slug } = await ctx.use(DepCrumbCategoryLoader);
  return { slug, loadedAt: new Date().toISOString() };
});

// Uncached sibling: reads the dependency after the cached body reached it on
// the MISS, and after a HIT replayed the cached entry.
export const DepCrumbSiblingLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return ctx.use(DepCrumbCategoryLoader);
});
