import { Suspense } from "react";
import { urls, Meta, Breadcrumbs, live } from "@rangojs/router";
import { createShellCacheMiddleware } from "@rangojs/router/cache";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ShellPriceLoader, ShellStreamLoader } from "./shell-cache.defs.js";
import { ShellCachePrice } from "../components/ShellCachePrice.js";
import { ShellCacheStream } from "../components/ShellCacheStream.js";
import { ShellCacheCounter } from "../components/ShellCacheCounter.js";
import { ShellDslActionButton } from "../components/ShellDslActionButton.js";

// PPR shell caching demo (docs/design/ppr-shell-resume.md).
//
// The hole/shell split follows the router's PPR eligibility contract: a hole
// exists only where a Suspense boundary separates loader consumption from the
// shell, and the route-level loading() DSL is that boundary (it becomes
// LoaderBoundary, which use()es the loader promise INSIDE its own Suspense). A
// loader route WITHOUT loading() awaits its loader data at tree-build
// (renderSegments' loading-less branch), so under capture's masked loaders the
// whole tree pends, the prelude comes back trivial, and the sanity gate refuses
// to store — x-rango-shell never flips to HIT. That exact mis-shape (hand-rolled
// <Suspense> + useLoader, no loading()) is how this route was first written.
//
// So the SHELL material lives in ShellCacheLayout — static text, a handle read
// (Breadcrumbs, rendered by RootLayout's BreadcrumbNav), an interactive client
// island (ShellCacheCounter) — all deterministic, so the cached prelude and the
// fresh hydration payload agree (no drift, no hydration errors). The route
// content is ONLY the live hole: ShellCachePrice behind loading(). On the first
// GET the shell cache captures the shell in the background (masked loader ->
// LoaderBoundary postpones -> prelude = layout + fallback); a later GET is
// served x-rango-shell: HIT with the frozen prelude flushed ahead of the
// resumed live price.

// live() demo (docs/design/ppr-shell-resume.md): a deterministic PPR hole even
// though the data is Promise.resolve(). Without live() a resolved promise settles
// during the capture quiet window and bakes into the shared shell prelude; live()
// holds it out, so capture postpones HERE (the prelude freezes the "Loading
// live..." fallback) and the resumed serve pass streams the value in. It sits
// inside ShellCacheLayout — the frozen shell region — precisely to show a value
// that would otherwise be captured being made a hole.
async function ShellCacheLiveValue() {
  const value = await live(() => Promise.resolve("LIVE-RESOLVED"));
  return <span data-testid="shell-live">{value}</span>;
}

function ShellCacheLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Cache" });
  ctx.use(Breadcrumbs)({ label: "Shell Cache", href: "/shell-cache" });

  return (
    <main data-testid="shell-cache-page">
      <h1 data-testid="shell-cache-header">Shell Cache Demo</h1>
      <p data-testid="shell-cache-static">
        Static shell content frozen into the cached prelude.
      </p>
      <ShellCacheCounter />
      <Suspense
        fallback={
          <span data-testid="shell-live-fallback">Loading live...</span>
        }
      >
        <ShellCacheLiveValue />
      </Suspense>
      <Outlet />
      <nav>
        <Link to="/" data-testid="shell-nav-home">
          Home
        </Link>
      </nav>
    </main>
  );
}

function ShellCachePricePage() {
  return <ShellCachePrice loader={ShellPriceLoader} />;
}

// Loader-carried-promise page, reused by BOTH /shell-cache/stream (WITH
// loading(), so the loader is a PPR hole) and /shell-cache/no-hole (NO loading(),
// so capture refuses and the route stays MISS forever while the inner promise
// still streams under axis 1). Identical component both times — the ONLY
// difference is whether the route carries loading().
function ShellCacheStreamPage() {
  return <ShellCacheStream loader={ShellStreamLoader} />;
}

// DSL-attached PPR shell caching (Deliverable 4c). The SAME middleware, attached
// via the urls() middleware() primitive (route middleware) instead of
// router.use() (global). Route middleware wraps the RENDER PASS: on a GET it arms
// the _shellCapture descriptor exactly like the global attachment, so MISS -> HIT
// and HIT composition are byte-identical. A POST action bypasses it (non-GET), and
// the background capture never re-enters it (match() only COLLECTS route
// middleware; the RSC handler's executeRender() executes it, which the capture
// bypasses — plus the _shellCaptureRun guard). NEW paths (/shell-cache-dsl) — the
// existing /shell-cache/* routes (router.use attachment) are untouched.
function ShellCacheDslLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Cache DSL" });
  return (
    <main data-testid="shell-dsl-page">
      <h1 data-testid="shell-dsl-header">Shell Cache DSL Demo</h1>
      <p data-testid="shell-dsl-static">
        Static DSL shell content frozen into the cached prelude.
      </p>
      <ShellCacheCounter />
      <ShellDslActionButton />
      <Outlet />
      <nav>
        <Link to="/" data-testid="shell-dsl-nav-home">
          Home
        </Link>
      </nav>
    </main>
  );
}

export const shellCacheDslPatterns = urls(
  ({ path, layout, loader, loading, middleware }) => [
    layout(ShellCacheDslLayout, () => [
      // The shell-cache middleware, attached as ROUTE middleware (not router.use()).
      middleware(createShellCacheMiddleware({ debug: true })),
      path(
        "/shell-cache-dsl",
        ShellCachePricePage,
        { name: "shellCacheDsl" },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="shell-dsl-price-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
  ],
);

export const shellCachePatterns = urls(({ path, layout, loader, loading }) => [
  layout(ShellCacheLayout, () => [
    path("/shell-cache", ShellCachePricePage, { name: "shellCache" }, () => [
      loader(ShellPriceLoader),
      loading(<div data-testid="shell-price-fallback">Loading price...</div>),
    ]),
    // Loader-carried promise WITH loading(): the loading() boundary is the hole.
    // On a HIT the resume streams three layers in one body — cached shell, then
    // the outer loader value + the inner Suspense fallback, then the
    // nested-promise inner value + $RC.
    path(
      "/shell-cache/stream",
      ShellCacheStreamPage,
      { name: "shellCacheStream" },
      () => [
        loader(ShellStreamLoader),
        loading(
          <div data-testid="shell-stream-fallback">Loading stream...</div>,
        ),
      ],
    ),
    // Same loader/component, but NO loading(): the loading-less branch awaits
    // loader data at tree-build, so capture's masked loader pins the tree and the
    // sanity gate refuses — x-rango-shell stays MISS forever. The nested inner
    // promise still streams under axis 1 (no loading() degrades only the caching,
    // never the route).
    path(
      "/shell-cache/no-hole",
      ShellCacheStreamPage,
      { name: "shellCacheNoHole" },
      () => [loader(ShellStreamLoader)],
    ),
  ]),
]);
