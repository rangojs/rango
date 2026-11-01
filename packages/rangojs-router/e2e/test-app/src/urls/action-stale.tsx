import { Suspense } from "react";
import { urls, type Handler, type Middleware } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ActionStaleAddressLoader,
  ActionStaleCartDefaultLoader,
  ActionStaleCartLoader,
  ActionStaleCountLoader,
  ActionStaleFillLoader,
  ActionStaleItemLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import {
  ActionStaleAddressValue,
  ActionStaleBar,
  ActionStaleBareAdd,
  ActionStaleCount,
  ActionStaleFillValue,
} from "./action-stale.client.js";
import { actionStaleState, wait } from "./action-stale.store.js";

// The action follow-up fixture: a layout with a cart count whose loader opts
// into `stale`, a layout loader on the default, one on the default that reads
// the cart, and a @modal slot; a product page with the actions; pages that
// answer at set delays; and two pages the document cache stores
// (/action-stale/cached/*). The product page renders a prefetching link only
// with ?prefetch=render (or =fill: the fill page's, on hover, passing on
// ?fillDelay; =fill-render: the same link prefetched on render, a
// speculative prefetch that defers the page's `prefetch: false` loader;
// =transition: the transition() basket's; =inflight: on hover, a basket that
// answers after 1500 ms, which an action's start does not cancel as it
// cancels queued ones), so no other case has a prefetch to consume.
// /action-stale/bare/* sit under a layout with no revalidate(): a basket and
// a chain of pages whose first prefetches it. /action-stale/counted is a
// layout whose loader re-runs on every navigation, with a prefetching link to
// its other page. Bodies:
// tests/shared-e2e/src/action-stale-navigation-scenario.ts,
// action-held-segments-scenario.ts, action-follow-up-scenario.ts and
// action-stale-prefetch-scenario.ts.
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
      <ActionStaleAddressValue />
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
      <Link
        to="/action-stale/basket"
        prefetch="none"
        data-testid="as-to-basket"
      >
        Basket
      </Link>
      {prefetch === "render" && (
        <>
          <Link
            to="/action-stale/other"
            prefetch="render"
            data-testid="as-to-other-prefetched"
          >
            Other, prefetched
          </Link>
          <Link
            to="/action-stale/basket"
            prefetch="render"
            data-testid="as-to-basket-prefetched"
          >
            Basket, prefetched
          </Link>
        </>
      )}
      {prefetch === "inflight" && (
        <Link
          to="/action-stale/basket?delay=1500"
          prefetch="hover"
          data-testid="as-to-slow-basket-prefetched"
        >
          Basket, answering after 1500 ms, prefetched on hover
        </Link>
      )}
      {prefetch === "transition" && (
        <Link
          to="/action-stale/basket-transition"
          prefetch="render"
          data-testid="as-to-basket-transition-prefetched"
        >
          Basket in a transition, prefetched
        </Link>
      )}
      {(prefetch === "fill" || prefetch === "fill-render") && (
        <Link
          to={
            fillDelay
              ? `/action-stale/fill?fillDelay=${fillDelay}`
              : "/action-stale/fill"
          }
          prefetch={prefetch === "fill" ? "hover" : "render"}
          data-testid="as-to-fill-prefetched"
        >
          {prefetch === "fill"
            ? "Fill, prefetched on hover"
            : "Fill, prefetched on render"}
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
// lands.
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
// right after it. Its `prefetch: false` loader runs in a hover's prefetch,
// and is filled after the click commits from a render link's.
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

// Reads the cart, after 300 ms, in the route itself: a prefetch of it carries
// the cart as it was then (#1329). With ?delay it reads the cart as the
// request arrives and answers `delay` ms later: a prefetch still in flight
// when an action lands carries the cart from before it.
const ActionStaleBasket: Handler = async (ctx) => {
  const delay = ctx.searchParams.get("delay");
  const early = delay === null ? undefined : actionStaleState().cart;
  await wait(delay === null ? 300 : Number(delay));
  const cart = early ?? actionStaleState().cart;
  return (
    <div data-testid="as-basket-page">
      <p data-testid="as-basket">{`basket:${cart}`}</p>
      <Link to="/action-stale/pdp" prefetch="none" data-testid="as-to-pdp">
        Product
      </Link>
    </div>
  );
};

// Pages under no revalidate(): a prefetch of one is stored in the slot every
// source page shares (the wildcard key), unlike a page under the layout
// above, whose loader's revalidate() scopes every response to its source page
// (#1331). The bare basket reads the cart after 300 ms and links to a chain
// of pages, each linking to the next, so a test can push enough entries to
// evict the basket's from the 20-entry history cache. The 22nd page, by when
// the basket's entry has left it, prefetches the basket (#1329: Back onto the
// evicted entry after an action must not be answered by that prefetch, which
// the action made stale). Prefetching last keeps the prefetch inside the
// test-app's 60 s prefetchCacheTTL however slow the hops are.
const BARE_HOP_PREFETCHING = 22;

function ActionStaleBareLayout() {
  return (
    <div data-testid="as-bare">
      <ActionStaleBareAdd />
      <Outlet />
    </div>
  );
}

const ActionStaleBareBasket: Handler = async () => {
  await wait(300);
  const { cart } = actionStaleState();
  return (
    <div data-testid="as-bare-basket-page">
      <p data-testid="as-bare-basket">{`basket:${cart}`}</p>
      <Link
        to="/action-stale/bare/hop?n=1"
        prefetch="none"
        data-testid="as-to-hop"
      >
        Hop
      </Link>
    </div>
  );
};

const ActionStaleBareHop: Handler = (ctx) => {
  const n = Number(ctx.searchParams.get("n") ?? 1);
  return (
    <div data-testid="as-hop">
      <p data-testid="as-hop-n">{`hop:${n}`}</p>
      <Link
        to={`/action-stale/bare/hop?n=${n + 1}`}
        prefetch="none"
        data-testid="as-to-next-hop"
      >
        Next hop
      </Link>
      {n === BARE_HOP_PREFETCHING && (
        <Link
          to="/action-stale/bare/basket"
          prefetch="render"
          data-testid="as-hop-to-basket-prefetched"
        >
          Basket, prefetched
        </Link>
      )}
    </div>
  );
};

// The basket page on a transition() route: the click on its stale prefetch
// and the revalidation's commit both go through the transition lane (#1329).
const ActionStaleBasketTransition: Handler = async () => {
  await wait(300);
  const { cart } = actionStaleState();
  return (
    <div data-testid="as-basket-transition-page">
      <p data-testid="as-basket-transition">{`basket:${cart}`}</p>
    </div>
  );
};

// A layout whose loader reads the cart and re-runs on every navigation
// (revalidate(() => true)), so every prefetch under it carries the count it
// read then: after an action the click on such a prefetch shows
// the count from before the write, then its revalidation the new one.
function ActionStaleCountedLayout() {
  return (
    <div data-testid="as-counted">
      <ActionStaleCount />
      <Outlet />
    </div>
  );
}

const ActionStaleCountedHome: Handler = () => (
  <div data-testid="as-counted-home">
    <Link
      to="/action-stale/counted/next"
      prefetch="render"
      data-testid="as-to-counted-next-prefetched"
    >
      Next, prefetched
    </Link>
  </div>
);

const ActionStaleCountedNext: Handler = () => (
  <div data-testid="as-counted-next">Next page</div>
);

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
      path("/action-stale/pdp", ActionStalePdp, () => [
        loader(ActionStaleAddressLoader, () => [
          revalidate(({ currentUrl, nextUrl }) =>
            currentUrl.href === nextUrl.href ? undefined : false,
          ),
        ]),
      ]),
      path("/action-stale/other", ActionStaleOther),
      path("/action-stale/slow", ActionStaleSlow),
      path("/action-stale/read", ActionStaleRead),
      path("/action-stale/basket", ActionStaleBasket),
      path(
        "/action-stale/basket-transition",
        ActionStaleBasketTransition,
        () => [transition()],
      ),
      layout(ActionStaleCountedLayout, () => [
        loader(ActionStaleCountLoader, () => [revalidate(() => true)]),
        path("/action-stale/counted", ActionStaleCountedHome),
        path("/action-stale/counted/next", ActionStaleCountedNext),
      ]),
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
    layout(ActionStaleBareLayout, () => [
      path("/action-stale/bare/basket", ActionStaleBareBasket),
      path("/action-stale/bare/hop", ActionStaleBareHop),
    ]),
  ],
);
