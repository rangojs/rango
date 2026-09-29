import type { HandlerContext } from "@rangojs/router";
import { BodyTaggedLoader } from "../loaders/loader-cache-tag.js";

/**
 * Renders the cached value of a loader whose body calls cacheTag() (see
 * urls.tsx /loader-cache-tag). `lct-loaded-at` repeats on a loader-cache HIT.
 */
export async function LoaderCacheTagPage(ctx: HandlerContext) {
  const data = await ctx.use(BodyTaggedLoader);
  return (
    <div data-testid="loader-cache-tag-page">
      <span data-testid="lct-loaded-at">{data.loadedAt}</span>
    </div>
  );
}
