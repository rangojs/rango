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

// ─── Streaming route: handler is behind loading() and pushes its handle
//     data AFTER an await, so the push lands while the segment is still
//     streaming (past the render barrier). rendered() must wait for it. ─────

async function StreamingPage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  // Defer the push past the barrier — a real streaming handler awaits its
  // data before pushing, so the push happens during the streaming phase.
  await new Promise((resolve) => setTimeout(resolve, 40));
  push("gadget-x");
  push("gadget-y");
  return (
    <div data-testid="rendered-streaming-page">
      <h1 data-testid="rendered-streaming-title">Streaming Products</h1>
      <p data-testid="rendered-streaming-ids">gadget-x,gadget-y</p>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-streaming" />
    </div>
  );
}

// ─── Streaming + cache: a loading() handler wrapped in cache(). The first
//     request renders fresh (streaming); the second is a cache HIT where the
//     handler output AND its streamed handle data are replayed. The loader
//     stays live and calls rendered() on the cache-hit path — it must read the
//     replayed handle data, not the (incomplete) live store. ─────────────────

async function StreamingCachedPage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  // Defer the push past the barrier (streaming), then it is captured into the
  // cache on the miss and replayed on the hit.
  await new Promise((resolve) => setTimeout(resolve, 40));
  push("widget-a");
  push("widget-b");
  return (
    <div data-testid="rendered-streaming-cached-page">
      <h1 data-testid="rendered-streaming-cached-title">Streaming Cached</h1>
      <span data-testid="rendered-streaming-cached-ts">{Date.now()}</span>
      <PriceDisplay
        loader={LivePricesLoader}
        testId="rendered-streaming-cached"
      />
    </div>
  );
}

// ─── Streaming + prerender: a loading() handler that is build-time
//     prerendered. At runtime the handler output and streamed handle data are
//     replayed from build artifacts; the live loader calls rendered() on the
//     prerender-replay path and must read the replayed handle data. ──────────

export const StreamingPrerenderPage = Prerender(async (ctx) => {
  const push = ctx.use(RenderedProducts);
  await new Promise((resolve) => setTimeout(resolve, 40));
  push("widget-a");
  push("widget-c");
  return (
    <div data-testid="rendered-streaming-prerender-page">
      <h1 data-testid="rendered-streaming-prerender-title">
        Streaming Prerender
      </h1>
      <PriceDisplay
        loader={LivePricesLoader}
        testId="rendered-streaming-prerender"
      />
    </div>
  );
});

// ─── Streaming deadlock route: a handler awaits a loader that calls
//     rendered() — a cycle. The guard must turn this into an error, not a
//     hang. Regression for the window AFTER the barrier resolves but while
//     rendered() is still awaiting handleStore.settled on a streaming tree. ──

// Must be an `export const` so the expose-internal-ids transform injects a
// stable $$id — the deadlock guard keys on loader.$$id.
export const DeadlockLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  return "unreachable";
});

async function StreamingDeadlockPage(ctx: any) {
  // Stay in flight (streaming) and then await the rendered() loader — the cycle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const data = await ctx.use(DeadlockLoader);
  return (
    <div data-testid="rendered-deadlock-page">
      <h1 data-testid="rendered-deadlock-title">Deadlock {data}</h1>
    </div>
  );
}

// ─── URL patterns ───────────────────────────────────────────────────────

export const renderedBarrierPatterns = urls(
  ({ path, layout, loader, cache, loading }) => [
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

        // Streaming + cache hit: loading() handler under cache(). rendered()
        // reads the replayed handle data on the cache-hit path.
        path(
          "/streaming-cached",
          StreamingCachedPage,
          { name: "streamingCached" },
          () => [
            loading(
              <div data-testid="rendered-streaming-cached-loading">
                Loading...
              </div>,
            ),
            loader(LivePricesLoader),
          ],
        ),
      ]),

      // "use cache" handler
      path("/use-cache", UseCacheHandler, { name: "useCache" }, () => [
        loader(LivePricesLoader),
      ]),

      // Prerendered handler
      path("/prerender", PrerenderProductsPage, { name: "prerender" }, () => [
        loader(LivePricesLoader),
      ]),

      // Streaming + prerender replay: loading() handler that is prerendered.
      // rendered() reads the replayed handle data on the prerender path.
      path(
        "/streaming-prerender",
        StreamingPrerenderPage,
        { name: "streamingPrerender" },
        () => [
          loading(
            <div data-testid="rendered-streaming-prerender-loading">
              Loading...
            </div>,
          ),
          loader(LivePricesLoader),
        ],
      ),

      // Layout + route accumulation: AccumulateLayout pushes widget-a,
      // AccumulatePage pushes widget-b + widget-c. Loader sees all three.
      layout(AccumulateLayout, () => [
        path("/accumulate", AccumulatePage, { name: "accumulate" }, () => [
          loader(LivePricesLoader),
        ]),
      ]),

      // Streaming route: loading() + a deferred handle push. rendered() waits
      // for the streaming handler to settle, then the loader reads the data.
      path("/streaming", StreamingPage, { name: "streaming" }, () => [
        loading(
          <div data-testid="rendered-streaming-loading">Loading prices...</div>,
        ),
        loader(LivePricesLoader),
      ]),

      // Streaming deadlock: a handler awaits a loader that calls rendered().
      // The guard must error rather than hang (regression for the post-barrier
      // streaming settle-wait window).
      path(
        "/streaming-deadlock",
        StreamingDeadlockPage,
        { name: "streamingDeadlock" },
        () => [
          loading(
            <div data-testid="rendered-deadlock-loading">Loading...</div>,
          ),
          loader(DeadlockLoader),
        ],
      ),
    ]),
  ],
);
