import type { HandlerContext } from "@rangojs/router";
import { DepCrumbsView } from "../components/DepCrumbsView.js";
import { DepCrumbProductLoader } from "../loaders/loader-cache-dep.js";

/**
 * A loader with its own cache() awaits a dependency that an uncached sibling
 * loader also reads (see urls.tsx /loader-cache-dep). The dependency's crumb
 * must appear once on the MISS and on the HIT, where it is the live run's.
 * `lcd-loaded-at` comes from the cached value, so an unchanged stamp marks a
 * loader-cache HIT.
 */
export async function LoaderCacheDepPage(ctx: HandlerContext) {
  const data = await ctx.use(DepCrumbProductLoader);
  return (
    <div data-testid="loader-cache-dep-page">
      <span data-testid="lcd-loaded-at">{data.loadedAt}</span>
      <DepCrumbsView />
    </div>
  );
}
