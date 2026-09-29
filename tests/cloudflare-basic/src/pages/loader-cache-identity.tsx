import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { CachedSessionLoader } from "../loaders/loader-cache-identity.js";

/**
 * Renders the value of a loader bound with its own cache() whose body reads
 * cookies() (see urls.tsx /loader-cache-identity/*). `lci-stamp` repeats on a
 * loader-cache HIT.
 */
export async function LoaderCacheIdentityPage(ctx: HandlerContext) {
  const { session, stamp } = await ctx.use(CachedSessionLoader);
  return (
    <div data-testid="loader-cache-identity-page">
      <span data-testid="lci-session">{session}</span>
      <span data-testid="lci-stamp">{stamp}</span>
    </div>
  );
}

/**
 * Reads the loader before the route below it binds it, so the route's
 * loader-cache MISS reuses this run (/loader-cache-identity/reader-first).
 */
export async function LoaderCacheIdentityLayout(ctx: HandlerContext) {
  const { session } = await ctx.use(CachedSessionLoader);
  return (
    <section>
      <span data-testid="lci-layout-session">{session}</span>
      <Outlet />
    </section>
  );
}
