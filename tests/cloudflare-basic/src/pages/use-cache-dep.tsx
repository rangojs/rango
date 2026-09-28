import type { HandlerContext } from "@rangojs/router";
import { DepCrumbsView } from "../components/DepCrumbsView.js";
import { DepCrumbCategoryLoader } from "../loaders/loader-cache-dep.js";

// Reads the dependency loader inside the cached body; the handler reads it
// live after the call.
async function getDepStamp(ctx: HandlerContext): Promise<string> {
  "use cache";
  await ctx.use(DepCrumbCategoryLoader);
  return new Date().toISOString();
}

/**
 * A "use cache" function reads a loader that the handler also reads live (see
 * urls.tsx /use-cache-dep). The loader's crumb must appear once on the MISS
 * and on the HIT, where it is the live run's. `ucd-cached-at` is the cached
 * value, so an unchanged stamp marks a "use cache" HIT.
 */
export async function UseCacheDepPage(ctx: HandlerContext) {
  const stamp = await getDepStamp(ctx);
  await ctx.use(DepCrumbCategoryLoader);
  return (
    <div data-testid="use-cache-dep-page">
      <span data-testid="ucd-cached-at">{stamp}</span>
      <DepCrumbsView />
    </div>
  );
}
