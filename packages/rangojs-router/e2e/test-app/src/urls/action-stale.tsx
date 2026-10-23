import { Suspense } from "react";
import { urls, type Handler, type Middleware } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ActionStaleCartDefaultLoader,
  ActionStaleCartLoader,
  ActionStaleFillLoader,
  ActionStaleItemLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import { ActionStaleBar, ActionStaleFillValue } from "./action-stale.client.js";
import { actionStaleState, wait } from "./action-stale.store.js";

// The action follow-up fixture: a layout with a cart count whose loader opts
// into `stale`, a layout loader on the default, one on the default that reads
// the cart, and a @modal slot; a product page with the actions; pages that
// answer at set delays; and two pages the document cache stores
// (/action-stale/cached/*). The product page renders a prefetching link only
// with ?prefetch=render (or =fill: the fill page's, on hover, passing on
// ?fillDelay), so no other case has a prefetch to consume. Bodies:
// tests/shared-e2e/src/action-stale-navigation-scenario.ts,
// action-held-segments-scenario.ts and action-follow-up-scenario.ts.
function ActionStaleLayout() {
  return (
    <div data-testid="as-layout">
      <ActionStaleBar />
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

// Answers at once, so an action's response arrives before its revalidation's
// 300 ms cart loader, which its commit waits for.
const ActionStalePdp: Handler = (ctx) => {
  const prefetch = ctx.searchParams.get("prefetch");
  const fillDelay = ctx.searchParams.get("fillDelay");
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
      <Link to="/action-stale/read" prefetch="none" data-testid="as-to-read">
        Read
      </Link>
      <Link
        to="/action-stale/transition"
        prefetch="none"
        data-testid="as-to-transition"
      >
        Transition
      </Link>
      <Link to="/action-stale/item" prefetch="none" data-testid="as-to-item">
        Item
      </Link>
      {prefetch === "render" && (
        <Link
          to="/action-stale/other"
          prefetch="render"
          data-testid="as-to-other-prefetched"
        >
          Other, prefetched
        </Link>
      )}
      {prefetch === "fill" && (
        <Link
          to={
            fillDelay
              ? `/action-stale/fill?fillDelay=${fillDelay}`
              : "/action-stale/fill"
          }
          prefetch="hover"
          data-testid="as-to-fill-prefetched"
        >
          Fill, prefetched on hover
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
      <Link to="/action-stale/slow" prefetch="none" data-testid="as-to-slow">
        Slow
      </Link>
    </div>
  );
};

// Answers after 900 ms: later than the 500 ms action and the 300 ms page
// before it.
const ActionStaleSlow: Handler = async () => {
  await wait(900);
  return <div data-testid="as-slow">Slow page</div>;
};

// Reads the cart as it starts and answers 1800 ms later: its read comes
// before the write an action makes at 800 ms, its commit after that action
// lands (dc-q78).
const ActionStaleRead: Handler = async () => {
  const { cart } = actionStaleState();
  await wait(1800);
  return <div data-testid="as-read">{`read:${cart}`}</div>;
};

// A transition() route that answers after 1200 ms: its navigation is still
// held when an action clicked just before it lands.
const ActionStaleTransition: Handler = async () => {
  await wait(1200);
  return <div data-testid="as-transition">Transition page</div>;
};

// Answers after 1500 ms, so a hover prefetch is still in flight at the click
// right after it; its `prefetch: false` loader is filled after the click
// commits.
const ActionStaleFill: Handler = async () => {
  await wait(1500);
  return (
    <div data-testid="as-fill-page">
      <Suspense fallback={<p data-testid="as-fill-fallback">fill…</p>}>
        <ActionStaleFillValue />
      </Suspense>
    </div>
  );
};

const ActionStaleItem: Handler = () => (
  <div data-testid="as-item-page">Item page</div>
);

// Two pages the document cache stores, each linking to the other. Their route
// middleware opts every response in (s-maxage). ?k keys their entries to one
// test, as the as-key cookie keys the state: the cache key ignores cookies.
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
  ({ layout, path, loader, middleware, revalidate, intercept, transition }) => [
    layout(ActionStaleLayout, () => [
      loader(ActionStaleCartLoader, () => [
        revalidate(
          ({ stale, defaultShouldRevalidate }) =>
            stale || defaultShouldRevalidate,
        ),
      ]),
      loader(ActionStalePlainLoader),
      loader(ActionStaleCartDefaultLoader),
      path("/action-stale/pdp", ActionStalePdp),
      path("/action-stale/other", ActionStaleOther),
      path("/action-stale/slow", ActionStaleSlow),
      path("/action-stale/read", ActionStaleRead),
      path("/action-stale/transition", ActionStaleTransition, () => [
        transition(),
      ]),
      path("/action-stale/fill", ActionStaleFill, () => [
        loader(ActionStaleFillLoader, { prefetch: false }),
      ]),
      path("/action-stale/item", ActionStaleItem, { name: "item" }),
      path("/action-stale/cached/a", ActionStaleCached, () => [
        middleware(cacheForAMinute),
      ]),
      path("/action-stale/cached/b", ActionStaleCached, () => [
        middleware(cacheForAMinute),
      ]),
      // Opened from the product page, the item is a modal over it.
      intercept(
        "@modal",
        ".item",
        async (ctx) => {
          const cart = await ctx.use(ActionStaleItemLoader);
          return (
            <div data-testid="as-modal">
              <p data-testid="as-item">{`item:${cart}`}</p>
            </div>
          );
        },
        () => [loader(ActionStaleItemLoader)],
      ),
    ]),
  ],
);
