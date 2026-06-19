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
  cookies,
  createRouter,
  createVar,
  getRequestContext,
  Meta,
  Breadcrumbs,
  redirect,
  DataNotFoundError,
  type Middleware,
} from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { Outlet, Link, ScrollRestoration } from "@rangojs/router/client";

import { ClockLoader, CounterLoader, FlashMessage } from "./shared.js";
import { increment, incrementWithResult } from "./actions.js";
import { productsPatterns } from "./urls/products.js";
// Route-colocated client components (each in its own directory) used to
// demonstrate per-route client chunking under `clientChunks: true`.
import { WidgetA } from "./routes/widgets/WidgetA.js";
import { ChartB } from "./routes/charts/ChartB.js";
// A "use client" error-boundary fallback: the built-in clientChunks strategy
// pulls registered error/notFound fallbacks into a dedicated app-fallback chunk.
import { ClientErrorFallback } from "./ClientErrorFallback.js";
import { DefaultClientError } from "./DefaultClientError.js";
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

// Server-component provider wrapper for the default error boundary (no
// "use client") — stands in for a real app's IntlProvider/theme wrapper that the
// boundary needs because the layout didn't mount on a thrown handler.
function FallbackWrap({
  label,
  children,
}: {
  label: string;
  children: import("react").ReactNode;
}) {
  return (
    <div data-testid="fallback-wrap" data-label={label}>
      {children}
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
  // Router-level default error boundary as a HANDLER FUNCTION that wraps the
  // "use client" boundary in a server provider — the common real-world shape (the
  // layout that would supply context did not mount). The client boundary
  // (DefaultClientError) is nested in the JSX the function returns, so the build
  // must invoke the handler and walk the tree to route it into app-fallback.
  defaultErrorBoundary: ({ error }) => (
    <FallbackWrap label={error instanceof Error ? "error" : "unknown"}>
      <DefaultClientError />
    </FallbackWrap>
  ),
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

          // Per-route client chunking demo: /widgets and /charts each render a
          // client component colocated in its own directory. With
          // `clientChunks: true` they ship as separate client chunks (+ CSS).
          path(
            "/widgets",
            (ctx) => {
              ctx.use(Meta)({ title: "Widgets" });
              return (
                <div data-testid="widgets-page">
                  <WidgetA />
                </div>
              );
            },
            { name: "widgets" },
          ),

          path(
            "/charts",
            (ctx) => {
              ctx.use(Meta)({ title: "Charts" });
              return (
                <div data-testid="charts-page">
                  <ChartB />
                </div>
              );
            },
            { name: "charts" },
          ),

          // Prefetch warming demo: a page that ships NONE of /widgets' client
          // code, with a render-strategy prefetch link to it. The prefetch
          // decodes /widgets' RSC eagerly, which imports its client chunk
          // up front, so clicking loads no new JS. Nameless on purpose (keeps
          // the named-routes gen file untouched); reached only by its e2e.
          path("/warm", (ctx) => {
            ctx.use(Meta)({ title: "Warm" });
            return (
              <div data-testid="warm-page">
                <Link
                  prefetch="render"
                  to="/widgets"
                  data-testid="warm-to-widgets"
                >
                  Widgets
                </Link>
              </div>
            );
          }),

          // Multi-group CSS co-render: a single page that renders client
          // components from TWO different route groups (routes/widgets +
          // routes/charts) at once. This is the case where per-group stylesheet
          // <link> precedence actually interacts (more groups -> more links;
          // see vite-plugin-react#1100). The e2e asserts BOTH route groups'
          // CSS apply with the correct cascade and no FOUC, dev + production.
          // WidgetA/ChartB still live under their own route dirs, so they stay
          // in app-widgets / app-charts (no module is duplicated by co-rendering).
          path(
            "/combined",
            (ctx) => {
              ctx.use(Meta)({ title: "Combined" });
              return (
                <div data-testid="combined-page">
                  <WidgetA />
                  <ChartB />
                </div>
              );
            },
            { name: "combined" },
          ),

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

          // Auth: INLINE server actions (function-level "use server") defined
          // right in the handler and colocated with their <form>s. Because we
          // stay on /login, there is no redirect: each action mutates the session
          // cookie and sets the flash with getRequestContext().setLocationState(),
          // then returns void. The framework re-renders /login after the action —
          // cookies().get() now reflects the change (signed-in vs. the form) — and
          // attaches the set location state to the action payload, so FlashBanner
          // shows it via useLocationState. A form action gets no `ctx` and an
          // inline "use server" closure can't close over it (not serializable), so
          // getRequestContext() (server-only, ALS-resolved) is how we reach
          // setLocationState. The bodies close over nothing, so they serialize
          // cleanly.
          path(
            "/login",
            (ctx) => {
              ctx.use(Meta)({ title: "Login" });
              const session = cookies().get("session")?.value;

              async function loginAction(formData: FormData): Promise<void> {
                "use server";
                const name = String(formData.get("name") ?? "").trim();
                if (!name) {
                  getRequestContext().setLocationState(
                    FlashMessage({ text: "Name is required." }),
                  );
                  return;
                }
                cookies().set("session", name, {
                  httpOnly: true,
                  path: "/",
                  sameSite: "lax",
                });
                getRequestContext().setLocationState(
                  FlashMessage({ text: `Welcome back, ${name}!` }),
                );
              }

              async function logoutAction(): Promise<void> {
                "use server";
                cookies().delete("session", { path: "/" });
                getRequestContext().setLocationState(
                  FlashMessage({ text: "Signed out." }),
                );
              }

              return (
                <div data-testid="login-page">
                  <FlashBanner />
                  {session ? (
                    <form action={logoutAction} data-testid="logout-form">
                      <span data-testid="signed-in">
                        Signed in as {session}
                      </span>{" "}
                      <button type="submit" data-testid="logout">
                        Log out
                      </button>
                    </form>
                  ) : (
                    <form action={loginAction} data-testid="login-form">
                      <input
                        name="name"
                        data-testid="login-name"
                        placeholder="Your name"
                      />
                      <button type="submit" data-testid="login-submit">
                        Log in
                      </button>
                    </form>
                  )}
                </div>
              );
            },
            { name: "login" },
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

          // Error boundary with a "use client" fallback. The fallback module is
          // pulled into the dedicated app-fallback chunk (not co-bundled with the
          // route code it catches). Renders only on error.
          path(
            "/errors/client-boom",
            () => {
              throw new Error("client boom!");
            },
            { name: "errClientBoom" },
            () => [errorBoundary(<ClientErrorFallback />)],
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
