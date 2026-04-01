import { urls, createHandle, createLoader, Prerender } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { PriceDisplay } from "../components/PriceDisplay.js";

// ─── Handle: product IDs pushed by handlers ────────────────────────────

export const RenderedProducts = createHandle<string>();

// ─── Loader: reads product IDs after rendered(), returns live prices ───

const PRICE_MAP: Record<string, number> = {
  "widget-a": 9.99,
  "widget-b": 19.99,
  "widget-c": 29.99,
  "gadget-x": 49.99,
  "gadget-y": 99.99,
};

export const LivePricesLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const productIds = ctx.use(RenderedProducts);
  const prices: Record<string, number> = {};
  for (const id of productIds) {
    prices[id] = PRICE_MAP[id] ?? 0;
  }
  return { prices, fetchedAt: Date.now() };
});

// ─── Fresh SSR handler (no cache, no prerender) ────────────────────────

function FreshPage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  push("widget-a");
  push("widget-b");

  return (
    <div data-testid="rendered-fresh-page">
      <h1 data-testid="rendered-fresh-title">Fresh Products</h1>
      <p data-testid="rendered-fresh-ids">widget-a,widget-b</p>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-fresh" />
    </div>
  );
}

// ─── Cached handler (cache() DSL) ──────────────────────────────────────

function CachedPage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  push("widget-b");
  push("widget-c");

  return (
    <div data-testid="rendered-cached-page">
      <h1 data-testid="rendered-cached-title">Cached Products</h1>
      <p data-testid="rendered-cached-ids">widget-b,widget-c</p>
      <span data-testid="rendered-cached-ts">{Date.now()}</span>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-cached" />
    </div>
  );
}

// ─── "use cache" handler ────────────────────────────────────────────────

async function UseCacheHandler(ctx: any) {
  "use cache";
  const push = ctx.use(RenderedProducts);
  push("gadget-x");
  push("gadget-y");

  return (
    <div data-testid="rendered-usecache-page">
      <h1 data-testid="rendered-usecache-title">Use Cache Products</h1>
      <p data-testid="rendered-usecache-ids">gadget-x,gadget-y</p>
      <span data-testid="rendered-usecache-ts">{Date.now()}</span>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-usecache" />
    </div>
  );
}

// ─── Prerendered handler ────────────────────────────────────────────────

export const PrerenderProductsPage = Prerender(async (ctx) => {
  const push = ctx.use(RenderedProducts);
  push("widget-a");
  push("widget-c");

  return (
    <div data-testid="rendered-prerender-page">
      <h1 data-testid="rendered-prerender-title">Prerendered Products</h1>
      <p data-testid="rendered-prerender-ids">widget-a,widget-c</p>
      <span data-testid="rendered-prerender-ts">{Date.now()}</span>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-prerender" />
    </div>
  );
});

// ─── Shared navigation layout (no handle push) ─────────────────────────

function RenderedBarrierLayout() {
  return (
    <div data-testid="rendered-barrier-layout">
      <nav data-testid="rendered-barrier-nav">
        <Link to="/rendered-barrier/fresh" data-testid="nav-fresh">
          Fresh
        </Link>
        <Link to="/rendered-barrier/cached" data-testid="nav-cached">
          Cached
        </Link>
        <Link to="/rendered-barrier/use-cache" data-testid="nav-use-cache">
          Use Cache
        </Link>
        <Link to="/rendered-barrier/prerender" data-testid="nav-prerender">
          Prerender
        </Link>
        <Link to="/rendered-barrier/accumulate" data-testid="nav-accumulate">
          Accumulate
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

// ─── Accumulation layout: pushes widget-a (tests layout + route) ────────

function AccumulateLayout(ctx: any) {
  const push = ctx.use(RenderedProducts);
  push("widget-a");
  return <Outlet />;
}

// ─── Route that also pushes products (tests layout + route accumulation) ─

function AccumulatePage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  push("widget-b");
  push("widget-c");

  return (
    <div data-testid="rendered-accumulate-page">
      <h1>Accumulated Products</h1>
      <p data-testid="rendered-accumulate-ids">widget-a,widget-b,widget-c</p>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-accumulate" />
    </div>
  );
}

// ─── URL patterns ───────────────────────────────────────────────────────

export const renderedBarrierPatterns = urls(
  ({ path, layout, loader, cache }) => [
    layout(RenderedBarrierLayout, () => [
      // Fresh SSR (no caching)
      path("/fresh", FreshPage, { name: "fresh" }, () => [
        loader(LivePricesLoader),
      ]),

      // Cached handler — cache wraps the route, loaders stay live
      cache({ ttl: 600 }, () => [
        path("/cached", CachedPage, { name: "cached" }, () => [
          loader(LivePricesLoader),
        ]),
      ]),

      // "use cache" handler
      path("/use-cache", UseCacheHandler, { name: "useCache" }, () => [
        loader(LivePricesLoader),
      ]),

      // Prerendered handler
      path("/prerender", PrerenderProductsPage, { name: "prerender" }, () => [
        loader(LivePricesLoader),
      ]),

      // Layout + route accumulation: AccumulateLayout pushes widget-a,
      // AccumulatePage pushes widget-b + widget-c. Loader sees all three.
      layout(AccumulateLayout, () => [
        path("/accumulate", AccumulatePage, { name: "accumulate" }, () => [
          loader(LivePricesLoader),
        ]),
      ]),
    ]),
  ],
);
