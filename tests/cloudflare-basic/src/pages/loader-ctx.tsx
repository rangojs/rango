import type { HandlerContext } from "@rangojs/router";
import { DepCrumbsView } from "../components/DepCrumbsView.js";
import { LoaderCtxItemLoader } from "../loaders/loader-cache-dep.js";

/**
 * A DSL loader passes its own ctx to a "use cache" function that pushes a
 * crumb through it (see urls.tsx /loader-ctx/:id). `lc-stamp` is the cached
 * value, so an unchanged stamp marks a "use cache" HIT.
 */
export async function LoaderCtxPage(ctx: HandlerContext<{ id: string }>) {
  const stamp = await ctx.use(LoaderCtxItemLoader);
  return (
    <div data-testid="loader-ctx-page">
      <span data-testid="lc-stamp">{stamp}</span>
      <DepCrumbsView />
    </div>
  );
}
