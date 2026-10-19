import { urls, type Handler, type Middleware } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ActionStaleCartLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import { ActionStaleBar } from "./action-stale.client.js";
import { wait } from "./action-stale.store.js";

// A layout cart count whose loader opts into `stale`, a layout loader on the
// default, a product page with the add-to-cart action, and a second page. The
// product page renders a prefetching link only with ?prefetch=render, so
// no other case has a prefetch to consume. Body:
// tests/shared-e2e/src/action-stale-navigation-scenario.ts.
function ActionStaleLayout() {
  return (
    <div data-testid="as-layout">
      <ActionStaleBar />
      <Outlet />
    </div>
  );
}

// Answers at once, so an action's response arrives before its revalidation's
// 300 ms cart loader, which its commit waits for.
const ActionStalePdp: Handler = (ctx) => {
  return (
    <div data-testid="as-pdp">
      <Link to="/action-stale/other" prefetch="none" data-testid="as-to-other">
        Other
      </Link>
      <Link
        to="/action-stale/other?delay=500"
        prefetch="none"
        data-testid="as-to-other-slow"
      >
        Other, slow
      </Link>
      {ctx.searchParams.get("prefetch") === "render" && (
        <Link
          to="/action-stale/other"
          prefetch="render"
          data-testid="as-to-other-prefetched"
        >
          Other, prefetched
        </Link>
      )}
    </div>
  );
};

/** ?delay ms (default 300). */
const ActionStaleOther: Handler = async (ctx) => {
  await wait(Number(ctx.searchParams.get("delay") ?? 300));
  return (
    <div data-testid="as-other">
      <Link to="/action-stale/pdp" prefetch="none" data-testid="as-to-pdp">
        Product
      </Link>
    </div>
  );
};

// Two pages the document cache stores, each linking to the other. Their route
// middleware opts every response in (s-maxage). ?k keys their entries to one
// test, as the as-key cookie keys the state: the cache key ignores cookies.
// Body: tests/shared-e2e/src/action-stale-navigation-scenario.ts.
const cacheForAMinute: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=60");
  await next();
};

const ActionStaleCached: Handler = (ctx) => {
  const page = ctx.url.pathname.endsWith("/a") ? "a" : "b";
  const other = page === "a" ? "b" : "a";
  return (
    <div data-testid={`as-cached-${page}`}>
      <Link
        to={`/action-stale/cached/${other}?k=${ctx.searchParams.get("k")}`}
        prefetch="none"
        data-testid={`as-to-cached-${other}`}
      >
        {other}
      </Link>
    </div>
  );
};

export const actionStalePatterns = urls(
  ({ layout, path, loader, middleware, revalidate }) => [
    layout(ActionStaleLayout, () => [
      loader(ActionStaleCartLoader, () => [
        revalidate(
          ({ stale, defaultShouldRevalidate }) =>
            stale || defaultShouldRevalidate,
        ),
      ]),
      loader(ActionStalePlainLoader),
      path("/action-stale/pdp", ActionStalePdp),
      path("/action-stale/other", ActionStaleOther),
      path("/action-stale/cached/a", ActionStaleCached, () => [
        middleware(cacheForAMinute),
      ]),
      path("/action-stale/cached/b", ActionStaleCached, () => [
        middleware(cacheForAMinute),
      ]),
    ]),
  ],
);
