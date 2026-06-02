// THE single server file.
//
// One createRouter() call, one urls() tree. Every server-side feature of
// @rangojs/router that fits a single app is expressed here or in the products
// route module: layouts, a nested include(), loaders (+ cache/SWR + revalidate),
// global and route-level middleware, route params, typed search schemas, segment
// cache() and a function-level "use cache", error + not-found boundaries,
// redirect(), parallel slots, an intercept() modal, loading() boundaries,
// transition() (content-hold same-route navigation), and Meta / Breadcrumbs.
//
// File organization mirrors the RSC boundary:
//   - Server-only config (context-var tokens) plus the route tree live here.
//   - Interactive UI lives in client.tsx ("use client").
//   - "use server" actions live in actions.tsx (separate by RSC rule).
//   - shared.tsx holds ONLY what crosses the boundary by identity: loaders the
//     client reads via useLoader, location-state read via useLocationState, and
//     the in-memory stores those loaders share with actions.
// See README.md in this folder.

import {
  createRouter,
  createVar,
  Meta,
  Breadcrumbs,
  redirect,
  DataNotFoundError,
  type Middleware,
} from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { Outlet, Link, ScrollRestoration } from "@rangojs/router/client";

import { ClockLoader, CounterLoader } from "./shared.js";
import { increment, incrementWithResult } from "./actions.js";
import { productsPatterns } from "./urls/products.js";
import {
  AppNav,
  BreadcrumbTrail,
  ClockWidget,
  FetchEcho,
  FreshClock,
  CountDisplay,
  IncrementButton,
  IncrementImperative,
  SearchControls,
  FlashBanner,
  SaveFlashButton,
  OriginLink,
  OriginReadout,
  NavHooksDemo,
  LinkStatusDemo,
  StaticHref,
  GlobalReverse,
} from "./client.js";

// ---------------------------------------------------------------------------
// Server-only config (declared at the top, referenced in the tree below).
// Context-var tokens are set in middleware and read in handlers; the client
// imports none of it. (The product catalog and its loader live in the products
// route module, urls/products.tsx. That group lives in its own file to
// demonstrate the mount-aware, local-name useReverse variant, whose per-module
// routes map is emitted by `rango generate` — CLI-only. useReverse does NOT
// require this: GlobalReverse on the home page reverses against the auto-emitted
// router.named-routes.gen.ts with full dotted global names — but only because it
// renders at the root mount; that inline form is mount-unaware (absolute paths)
// and would double-prefix under a non-root include.)
// ---------------------------------------------------------------------------

// Typed context-var tokens — set in middleware, read in handlers.
const RequestIdVar = createVar<string>();
const RouteScopeVar = createVar<string>();

// ---------------------------------------------------------------------------
// Cache store + named profiles. Loaders are excluded from the segment cache, so
// cached UI coexists with always-fresh loader data.
// ---------------------------------------------------------------------------

const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 120 },
});

// ---------------------------------------------------------------------------
// Function-level "use cache": its return value is memoized; module state proves
// hits (the counter only advances on a miss). cookies()/headers()/ctx writes
// would throw inside this scope.
// ---------------------------------------------------------------------------

let useCacheSeq = 0;
async function getCachedStamp(): Promise<{ seq: number }> {
  "use cache: short";
  useCacheSeq += 1;
  return { seq: useCacheSeq };
}

// Segment-render counter: advances only when the cached /cache segment is
// actually re-rendered (a cache miss), so a stable value across reloads proves
// a cache hit.
let segmentRenderSeq = 0;

// ---------------------------------------------------------------------------
// Middleware.
// ---------------------------------------------------------------------------

let requestSeq = 0;
const requestIdMiddleware: Middleware = async (ctx, next) => {
  requestSeq += 1;
  const id = `req-${requestSeq}`;
  ctx.set(RequestIdVar, id);
  ctx.header("X-Mini-Request", id);
  return next();
};

const routeScopeMiddleware: Middleware = async (ctx, next) => {
  ctx.set(RouteScopeVar, "secret-scope");
  return next();
};

// ---------------------------------------------------------------------------
// Server-rendered boundary fallbacks (plain server components — no hooks).
// ---------------------------------------------------------------------------

function ErrorFallback() {
  return (
    <div data-testid="error-fallback">
      <h2>Something broke</h2>
      <Link to="/" data-testid="error-home-link">
        Home
      </Link>
    </div>
  );
}

function NotFoundFallback() {
  return (
    <div data-testid="notfound-fallback">
      <h2>Not found here</h2>
      <Link to="/" data-testid="notfound-home-link">
        Home
      </Link>
    </div>
  );
}

function GlobalNotFound() {
  return (
    <div data-testid="global-notfound">
      <h2>404 — no such page</h2>
      <Link to="/" data-testid="global-notfound-home-link">
        Home
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

export const router = createRouter({
  cache: { store: cacheStore },
  cacheProfiles: {
    short: { ttl: 60, swr: 120 },
  },
  notFound: <GlobalNotFound />,
})
  // Global middleware: tags every request with an id (header + ctx var).
  .use(requestIdMiddleware)
  .routes(
    ({
      path,
      layout,
      include,
      loader,
      cache,
      revalidate,
      middleware,
      errorBoundary,
      notFoundBoundary,
    }) => [
      layout(
        (ctx) => {
          const meta = ctx.use(Meta);
          meta({ title: { template: "%s · Mini", default: "Mini" } });
          const crumb = ctx.use(Breadcrumbs);
          crumb({ label: "Home", href: "/" });
          return (
            <div data-testid="app-root">
              <header data-testid="app-header">
                <h1>Rango Mini</h1>
                <AppNav />
                <BreadcrumbTrail />
              </header>
              <main data-testid="app-main">
                <Outlet />
              </main>
              <ScrollRestoration />
            </div>
          );
        },
        () => [
          // Home: loader + useLoader + useFetchLoader + useRefreshLoaders.
          path(
            "/",
            (ctx) => {
              const meta = ctx.use(Meta);
              meta({ title: "Home" });
              return (
                <div data-testid="home-page">
                  <p data-testid="request-id">
                    {ctx.get(RequestIdVar) ?? "none"}
                  </p>
                  {/* Server-side reverse: named route -> path (typed via the
                      RegisteredRoutes augmentation). */}
                  <p data-testid="reverse-counter">{ctx.reverse("counter")}</p>
                  <p data-testid="reverse-product">
                    {ctx.reverse("products.detail", { id: "2" })}
                  </p>
                  <ClockWidget />
                  <FetchEcho />
                  <StaticHref />
                  <GlobalReverse />
                </div>
              );
            },
            { name: "home" },
            () => [loader(ClockLoader)],
          ),

          // Counter: server action + revalidate-on-action (ctx.isAction).
          path(
            "/counter",
            (ctx) => {
              ctx.use(Meta)({ title: "Counter" });
              ctx.use(Breadcrumbs)({ label: "Counter", href: "/counter" });
              return (
                <div data-testid="counter-page">
                  <CountDisplay />
                  <IncrementButton />
                  <IncrementImperative />
                </div>
              );
            },
            { name: "counter" },
            () => [
              loader(CounterLoader, () => [
                revalidate(
                  ({ isAction }) =>
                    isAction(increment, incrementWithResult) || undefined,
                ),
              ]),
            ],
          ),

          // Products: include() of the sub-app above.
          include("/products", productsPatterns, { name: "products" }),

          // Search: typed search schema.
          path(
            "/search",
            (ctx) => {
              ctx.use(Meta)({ title: "Search" });
              const { q, page } = ctx.search;
              return (
                <div data-testid="search-page">
                  <p data-testid="search-q">q:{q ?? "none"}</p>
                  <p data-testid="search-page-num">
                    page:{page !== undefined ? String(page) : "none"}
                  </p>
                  <p data-testid="search-page-type">
                    page-type:{page !== undefined ? typeof page : "none"}
                  </p>
                  <SearchControls />
                </div>
              );
            },
            { name: "search", search: { q: "string?", page: "number?" } },
          ),

          // Cache: segment cache + function-level "use cache: short" (named
          // profile). The fresh loader value still changes every request
          // (dynamic hole), proving loaders run outside the cache.
          cache({ ttl: 60, swr: 120 }, () => [
            path(
              "/cache",
              async (ctx) => {
                ctx.use(Meta)({ title: "Cache" });
                segmentRenderSeq += 1;
                const cached = await getCachedStamp();
                return (
                  <div data-testid="cache-page">
                    <p data-testid="segment-seq">{segmentRenderSeq}</p>
                    <p data-testid="usecache-seq">{cached.seq}</p>
                    <FreshClock />
                  </div>
                );
              },
              { name: "cache" },
              () => [loader(ClockLoader)],
            ),
          ]),

          // Location state.
          path(
            "/state",
            (ctx) => {
              ctx.use(Meta)({ title: "State" });
              return (
                <div data-testid="state-page">
                  <FlashBanner />
                  <OriginReadout />
                  <SaveFlashButton />
                  <OriginLink />
                </div>
              );
            },
            { name: "state" },
          ),

          // Navigation hooks.
          path(
            "/hooks",
            (ctx) => {
              ctx.use(Meta)({ title: "Hooks" });
              return (
                <div data-testid="hooks-page">
                  <NavHooksDemo />
                  <LinkStatusDemo />
                </div>
              );
            },
            { name: "hooks" },
          ),

          // Route-level middleware on a wrapped subtree.
          layout(
            () => (
              <div data-testid="secret-layout">
                <Outlet />
              </div>
            ),
            () => [
              middleware(routeScopeMiddleware),
              path(
                "/secret",
                (ctx) => (
                  <div data-testid="secret-page">
                    <p data-testid="route-scope">
                      {ctx.get(RouteScopeVar) ?? "none"}
                    </p>
                    <p data-testid="secret-request-id">
                      {ctx.get(RequestIdVar) ?? "none"}
                    </p>
                  </div>
                ),
                { name: "secret" },
              ),
            ],
          ),

          // Error boundary.
          path(
            "/errors/boom",
            () => {
              throw new Error("boom!");
            },
            { name: "errBoom" },
            () => [errorBoundary(<ErrorFallback />)],
          ),

          // Not-found boundary (thrown DataNotFoundError).
          path(
            "/errors/missing",
            () => {
              throw new DataNotFoundError("missing widget");
            },
            { name: "errMissing" },
            () => [notFoundBoundary(<NotFoundFallback />)],
          ),

          // Redirect from a handler.
          path("/errors/go", () => redirect("/counter"), { name: "errGo" }),
        ],
      ),
    ],
  );

// Register routes for type-safe reverse() / href / Link across the app.
type AppRoutes = typeof router.routeMap;
declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
