---
name: route
description: Define routes with path() in @rangojs/router — URL params, catch-alls, typed search params, the handler context, handler-to-child data, and redirects. Use when creating a new page or route, or asking how to define a URL path and its handler.
argument-hint: [pattern]
---

# Defining Routes with path()

`path(pattern, handler, options?, use?)` maps a URL pattern to a handler inside
`urls()`. This skill covers patterns and params, typed search params, the handler
context, passing handler data to child segments, and redirects.

Related skills: `/layout` (wrap routes in shared UI), `/response-routes`
(`path.json()`, `path.text()`, … endpoints), `/links` (URL generation),
`/composability` (`include()` and reusable config), `/loader` (data).

## Basic Route

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  path("/contact", ContactPage, { name: "contact" }),
]);
```

## Route with Parameters

```typescript
urls(({ path }) => [
  // Single parameter
  path("/product/:slug", ProductPage, { name: "product" }),

  // Multiple parameters
  path("/blog/:year/:month/:slug", BlogPostPage, { name: "blogPost" }),

  // Optional parameter (add ? suffix)
  path("/search/:query?", SearchPage, { name: "search" }),
]);
```

### Optional URL params at runtime

Absent optional params are **omitted from `ctx.params`** — `ctx.params.<name>`
reads as `undefined`, matching the `RouteParams<"name">` type
(`{ query?: string }`). Use `??` to default and `=== undefined` to check
absence:

```typescript
path("/search/:query?", (ctx) => {
  const query = ctx.params.query ?? ""; // works — undefined coalesces
  if (ctx.params.query === undefined) return <EmptySearch />;
  return <Results query={ctx.params.query} />;
}, { name: "search" });
```

For the common pattern of an optional locale prefix
(`include("/:locale?", routes)`) and the wider react-intl integration —
locale detection, fallback chains, URL generation with absent locale —
see `/i18n`.

### Named catch-all params (`:name+` / `:name*`)

A catch-all consumes the **rest of the path** and exposes it as a single
decoded string at `ctx.params.<name>`, with the internal `/` separators kept.
It only acts as a catch-all in the **last** segment of the pattern (see the
parsing rule at the end of this section).

- `:name+` — **one-or-more** segments (Next `[...name]`, React-Router splat).
  `/docs/:slug+` matches `/docs/a` and `/docs/a/b/c`, but **not** the bare
  `/docs`.
- `:name*` — **zero-or-more** segments (Next `[[...name]]`). `/docs/:slug*`
  additionally matches the bare `/docs`, binding `ctx.params.slug` to `""`.

```typescript
urls(({ path }) => [
  // /shop/electronics/phones -> ctx.params.path === "electronics/phones"
  path("/shop/:path+", ShopCatchAll, { name: "shopCatchAll" }),

  // /docs         -> ctx.params.slug === ""
  // /docs/intro   -> ctx.params.slug === "intro"
  // /docs/a/b     -> ctx.params.slug === "a/b"
  path("/docs/:slug*", (ctx) => {
    const parts = ctx.params.slug === "" ? [] : ctx.params.slug.split("/");
    return <Docs segments={parts} />;
  }, { name: "docs" }),
]);
```

`ctx.params.<name>` is always a `string` for a catch-all (never `undefined`) —
`:name*` binds `""` for the empty case, so read it directly. URL generation
(`ctx.reverse()`, `href()`) rebuilds the URL with separators preserved:
`ctx.reverse("docs", { slug: "a/b" })` -> `/docs/a/b`.

The value is the URL-decoded remainder. `split("/")` recovers the segments in the
common case, but note that a segment containing an encoded slash (`%2F`) decodes
to a literal `/` and is therefore indistinguishable from a separator — the same
trade-off the bare `*` splat has. If you need to distinguish those, match on the
raw pathname instead.

The bare unnamed wildcard `path("/files/*", …)` still works and is read at
`ctx.params["*"]`; prefer a named catch-all when you want a typed param key.

Parsing rule: `+` / `*` is a catch-all modifier **only** when it is the bare
final character of the last segment. Anywhere else it is read as a literal
suffix character, not rejected: `/docs/:slug+/edit` matches `/docs/x+/edit`,
and `:slug*.html`, `:slug?*`, and `:slug(a|b)+` are ordinary params followed by
a literal suffix.

### Constrained and suffixed params

```typescript
urls(({ path }) => [
  // Only /en/about or /gb/about match; ctx.params.locale is typed "en" | "gb"
  path("/:locale(en|gb)/about", AboutPage, { name: "about" }),

  // Constrained + optional: /pricing, /en/pricing, /gb/pricing
  path("/:locale(en|gb)?/pricing", PricingPage, { name: "pricing" }),

  // Literal suffix: /files/report.pdf -> ctx.params.name === "report"
  path("/files/:name.pdf", PdfViewer, { name: "pdf" }),
]);
```

## Route Handler Patterns

### Component Function

```typescript
path("/about", AboutPage, { name: "about" })

// AboutPage receives context
function AboutPage(ctx: HandlerContext) {
  return <div>About Us</div>;
}
```

### Inline JSX

```typescript
path("/about", () => <AboutPage />, { name: "about" })
```

### Handler with Context Access

```typescript
path("/product/:slug", (ctx) => {
  const { slug } = ctx.params;
  return <ProductPage slug={slug} />;
}, { name: "product" })
```

### Async Handler (Streaming)

```typescript
path("/product/:slug", async (ctx) => {
  const product = await fetchProduct(ctx.params.slug);
  return <ProductPage product={product} />;
}, { name: "product" })
```

## Route Options

All options are optional; with none, pass the `use` callback as the third
argument: `path("/x", Page, () => [loader(L)])`.

```typescript
path("/product/:slug", ProductPage, {
  name: "product", // route name for href(), ctx.reverse(), Handler<"product">
  search: { tab: "string?" }, // typed ctx.search (next section)
  trailingSlash: "never", // "never" | "always" | "ignore"
  ppr: true, // serve a cached HTML shell with live holes (see /ppr)
});
```

- `name` — unnamed routes still match but can't be reversed by name or typed
  with `Handler<"name">`. Inside an `include()`, the include's `name` option
  decides whether the name is visible globally (see "Nested Routes" below).
- `trailingSlash` — `"never"` redirects `/docs/` to `/docs`, `"always"` redirects `/docs`
  to `/docs/`, `"ignore"` matches both. Unset, the pattern's own trailing slash
  decides.

### Typed Search Params

Add a `search` schema to get typed `ctx.search`:

```typescript
path("/search", SearchPage, {
  name: "search",
  search: { q: "string", page: "number?", sort: "string?" },
});
```

Use `Handler<"name">` for typed search params (resolves from the generated route map automatically):

```typescript
import type { Handler } from "@rangojs/router";

export const SearchPage: Handler<"search"> = (ctx) => {
  // ctx.search is typed: { q: string | undefined; page?: number; sort?: string }
  const { q = "", page = 1, sort } = ctx.search;
  // ctx.searchParams is always URLSearchParams
  return <SearchResults q={q} page={page} sort={sort} />;
};
```

Supported types: `"string"`, `"number"`, `"boolean"`, with `?` suffix for optional.

- **Missing params are `undefined` regardless of required/optional** — a client
  can always omit them, so the handler must default or check. The
  required/optional distinction is a consumer-facing contract that drives
  `href()` / `ctx.reverse()` autocomplete.
- `"number"` accepts decimal numerals (`42`, `-3.5`, `1e3`). Empty values, hex
  (`0x10`), and non-finite values are treated as missing, not coerced.
- `"boolean"` is `true` for `"true"` / `"1"` and `false` for any other present
  value.

Use `RouteSearchParams<"name">` and `RouteParams<"name">` to extract types for props:

```typescript
import type { RouteSearchParams, RouteParams } from "@rangojs/router";

type SP = RouteSearchParams<"search">; // { q: string | undefined; page?: number; sort?: string }
type P = RouteParams<"blogPost">; // { year: string; month: string; slug: string }
```

## Route Children

Add loaders, loading states, and other features as children:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),
  revalidate(productRevalidation),
])
```

## Handler Data Ownership

When a route has children (orphan layouts, parallels), the handler executes
first. Use `ctx.set(key, value)` to share data with children, who read it
via `ctx.get(key)`. A route-level `cache()` wraps all of the entry's segments
together, so on a cache hit none of them run and on a miss all of them do.

This stays consistent after actions with no configuration: on an action, the
route segment, its loaders, and the children declared inside the `path()`
(orphan layouts and their parallels) all re-run together, handler first. See
`/rango` → "Passing data down the tree" for the safest-first ladder.

### Typed context variables with createVar

Use `createVar<T>()` to create a typed token for `ctx.set()`/`ctx.get()`.
The token is imported by both the handler (producer) and layout (consumer),
making the data contract explicit and compile-time verified:

```typescript
import { createVar } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// Typed token -- shared between handler and layout
interface DashboardData {
  title: string;
  stats: { views: number };
}
const Dashboard = createVar<DashboardData>();

path("/dashboard/:id", async (ctx) => {
  const data = await fetchDashboard(ctx.params.id);
  ctx.set(Dashboard, data);   // type-checked
  return <DashboardPage data={data} />;
}, { name: "dashboard" }, () => [
  layout((ctx) => {
    const data = ctx.get(Dashboard);  // typed as DashboardData | undefined
    return (
      <div>
        <h1>{data?.title}</h1>
        <Outlet />
        <ParallelOutlet name="@sidebar" />
      </div>
    );
  }),
  parallel({
    "@sidebar": (ctx) => {
      const data = ctx.get(Dashboard);
      return <Sidebar stats={data?.stats} />;
    },
  }),
])
```

String keys still work (`ctx.set("key", value)` / `ctx.get("key")`), but
`createVar<T>()` is preferred for type safety.

Write with `ctx.set()` from middleware, route handlers, and layout handlers;
read with `ctx.get()` in the segments they wrap. Handlers run before their
orphan layouts and parallels (handler-first), so those children see the value.
Parallels and intercepts render last, so treat them as readers.

#### Non-cacheable context variables

Mark a var as non-cacheable when it holds inherently request-specific data
(sessions, auth tokens, per-request IDs). There are two ways:

```typescript
// Var-level: every value written to this var is non-cacheable
const Session = createVar<SessionData>({ cache: false });

// Write-level: escalate a normally-cacheable var for this specific write
const Theme = createVar<string>();
ctx.set(Theme, userTheme, { cache: false });
```

"Least cacheable wins" — if either the var definition or the write site says
`cache: false`, the value is non-cacheable.

Reading a non-cacheable var directly with `ctx.get()` inside a `cache()`
boundary throws at runtime, so request-specific data can't be baked into a
cached segment:

```typescript
cache({ ttl: 60 }, () => [
  path("/account", (ctx) => {
    const session = ctx.get(Session); // throws: non-cacheable read inside cache()
    return <Account session={session} />;
  }, { name: "account" }),
]);
```

The guard is scoped to the `cache()` DSL boundary. It does not fire inside a
`"use cache"` function body and does not follow derived values (a string copied
out of `Session` and cached elsewhere is not tracked). Loaders are exempt — they
run fresh on every request. Cacheable vars (the default) can be read freely
inside cache scopes. See `/cache-guide` → "Context Variable Cache Safety".

### Revalidation Contracts for Handler Data

> **Scope: `revalidate()` is a partial-render concern, not a cache concern.**
> It decides whether this segment re-runs and streams to the client on a
> navigation or action — never whether a cached value is stale. The cache
> decides hit/miss/ttl/swr independently and never reads `revalidate()`. See
> `/cache-guide` → "Two axes" and `/rango` → "The shape of rango".

With no `revalidate()` configured, an entry needs no contract: on an action
the route handler and its children re-run together by default, so handler
data stays consistent on its own. Contracts matter in two cases:

1. **You narrow the entry's revalidation** with a predicate that can return a
   hard `false` (e.g. `ctx.isAction() ? ctx.isAction(X) : undefined`). A hard
   `false` on one side of a
   producer/consumer pair desyncs it — the child re-runs by default and reads
   `undefined`, or vice versa. Put the same named contract on the route and
   its dependent children so they narrow together.
2. **The producer is an outer entry** (a standalone `layout()` above this
   route). Outer entries skip action revalidation by default, so the shared
   contract is mandatory — see `/layout` → "Revalidation Contracts".

```typescript
// revalidation-contracts.ts
import type { Revalidate } from "@rangojs/router";
import * as CheckoutActions from "./actions/checkout";

// The route and its children re-run after every action by default, so this
// contract narrows them together: after an action, re-run only for checkout
// actions; on navigation, undefined keeps the default. After an action it is a
// hard decision, so later revalidators on the same segment do not run.
export const revalidateCheckoutData: Revalidate = (ctx) =>
  ctx.isAction() ? ctx.isAction(CheckoutActions) : undefined;

path("/checkout", CheckoutPage, { name: "checkout" }, () => [
  revalidate(revalidateCheckoutData), // producer (route handler)
  layout(CheckoutLayout, () => [
    revalidate(revalidateCheckoutData), // consumer
    parallel({ "@summary": CheckoutSummary }, () => [
      revalidate(revalidateCheckoutData),
    ]),
  ]),
]);
```

If children depend on multiple upstream domains, match them in one narrowing
contract (`ctx.isAction(CheckoutActions, AuthActions)`): a second narrowing
contract on the same segment would never run, because the first one's hard
`false` ends the chain.

For cleaner route trees, expose contract helpers and spread them:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateCheckout = () => [revalidate(revalidateCheckoutData)];

path("/checkout", CheckoutPage, { name: "checkout" }, () => [
  revalidateCheckout(),
  layout(CheckoutLayout, () => [revalidateCheckout()]),
]);
```

## Redirects

`redirect(url, statusOrOptions?)` returns a `Response` (default status `302`).
Return it from a handler or middleware, or throw it from a loader.

### Basic redirect

```typescript
import { redirect } from "@rangojs/router";

path("/old-page", () => redirect("/new-page"), { name: "oldPage" });
```

### Redirect with custom status

```typescript
path("/moved", () => redirect("/new-location", 301), { name: "moved" });
```

Root-relative targets are prefixed with the router's `basename` automatically
(an already-prefixed URL is left alone).

### Off-origin redirects

Cross-origin targets are blocked by a same-origin guard and replaced with the
app root. Opt in explicitly for an intended off-host redirect:

```typescript
path(
  "/login",
  () => redirect("https://accounts.example.com/oauth", { external: true }),
  { name: "login" },
);
```

> **Redirecting from a route with `loading()`:** an `async` handler that returns
> a `Response`/`redirect()` on a route that also declares `loading()` is streamed,
> so the redirect is rendered into the RSC stream instead of becoming an HTTP
> redirect. For a real HTTP redirect, issue it from `middleware` or a
> **synchronous** handler return — pre-stream redirect authority belongs there.
> (A loader `throw redirect()` also navigates the user, but it is ALWAYS a
> client-side replace on document loads — 200 document, never a 302; see
> `/loader` → "Loader Authority". Dev logs a warning if this is hit.)

### Redirect with location state

Carry typed state through redirects (e.g. flash messages):

```typescript
import { redirect, createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});

path(
  "/save",
  (ctx) => {
    // ... save logic
    return redirect("/dashboard", {
      state: [FlashMessage({ text: "Item saved!" })],
    });
  },
  { name: "save" },
);

// With custom status + state
path(
  "/action",
  (ctx) => {
    return redirect("/target", {
      status: 303,
      state: [FlashMessage({ text: "Action complete" })],
    });
  },
  { name: "action" },
);
```

`state` takes one entry or an array. Read it on the target page with
`useLocationState(FlashMessage)` (from `@rangojs/router/client`). The
`{ flash: true }` option makes it auto-clear. Without `{ flash: true }`,
state persists on back/forward. See `/hooks` for details.

### ctx.setLocationState()

Attach location state to any server response (not just redirects):

```typescript
import { createLocationState } from "@rangojs/router";

const ServerInfo = createLocationState<{ data: string }>();

path("/dashboard", (ctx) => {
  ctx.setLocationState(ServerInfo({ data: "welcome" }));
  return <Dashboard />;
}, { name: "dashboard" })
```

State flows to the browser via the RSC payload and is merged into
`history.pushState()`. Only works for SPA (partial) navigations.

## Handler Context

Every handler receives a context object:

```typescript
// Simplified sketch. Import the real type with
// `import type { HandlerContext } from "@rangojs/router"`.
interface HandlerContext<TParams = {}, TEnv = DefaultEnv, TSearch = {}> {
  // Request
  params: TParams; // URL params
  request: Request; // original request (raw transport URL, headers, body)
  url: URL; // request URL with internal _rsc* params stripped
  pathname: string;
  searchParams: URLSearchParams; // always URLSearchParams (_rsc* stripped)
  search: ResolveSearchSchema<TSearch>; // typed from the search schema ({} without one)
  env: TEnv; // platform bindings
  routeName?: string; // matched route name (undefined for unnamed routes)

  // Data flow
  get<T>(contextVar: ContextVar<T>): T | undefined; // also accepts a string key
  set<T>(
    contextVar: ContextVar<T>,
    value: T,
    options?: { cache?: boolean },
  ): void;
  use<T>(loader: LoaderDefinition<T>): Promise<T>; // loader data (memoized per request)
  use<T>(handle: Handle<T>): HandlePush<T>; // push function for a handle

  // Response
  headers: Headers; // response headers, merged into the final response
  setLocationState(entries: LocationStateEntry | LocationStateEntry[]): void;
  reverse(
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ): string;
  waitUntil(fn: () => Promise<void>): void; // work that continues after the response

  // Mode
  build: boolean; // true while pre-rendering at build time
  dev: boolean; // true under Vite dev
  dynamic(): void; // opt this request out of PPR shell capture (see /ppr)
  theme?: Theme; // plus setTheme?() — only when the router enables themes (/theme)
}
```

### Using Context

```typescript
path("/product/:slug", (ctx) => {
  // Access URL params
  const { slug } = ctx.params;

  // Access query params (untyped - use search schema for typed access)
  const tab = ctx.searchParams.get("tab");

  // Access platform bindings
  const db = ctx.env.DB;

  // Push handle data: ctx.use(Handle) returns a push function
  const pushCrumb = ctx.use(Breadcrumbs);
  pushCrumb({ label: "Product", href: `/product/${slug}` });

  // Set a response header
  ctx.headers.set("Cache-Control", "private, max-age=60");

  return <ProductPage slug={slug} tab={tab} />;
}, { name: "product" })
```

## Nested Routes

Use layouts to nest routes:

```typescript
urls(({ path, layout }) => [
  layout(<ShopLayout />, () => [
    path("/shop", ShopIndex, { name: "shop.index" }),
    path("/shop/cart", CartPage, { name: "shop.cart" }),
    path("/shop/product/:slug", ProductPage, { name: "shop.product" }),
  ]),
])
```

For composing whole route MODULES, reach for `include()` — and prefer the
code-split form `include("/shop", () => import("./shop-patterns"))` for any
group that is a natural unit: it keeps the group off the cold-start path, and
measured first-hit cost scales with routes-per-chunk, so many small groups
beat one giant one. Sizing rules and the numbers behind them:
[skills/composability](../composability/SKILL.md) → "Sizing async include
groups (measured)".

`include()` has three name modes: omit `{ name }` for a private local route-name
scope, pass a non-empty name to namespace children globally, or pass
`{ name: "" }` to flatten globally unique child names into the parent map. URL
matching works in all three modes; the option controls name visibility, not
whether the routes mount.

## View Transitions

A route can configure its own `transition()` — the wrap goes around the route's component itself (routes are leaves; they have no separate default outlet channel). If the route component renders a `<ParallelOutlet />` directly, that slot remains inside the route's VT subtree, so prefer mounting parallel slots in a layout when combining intercept modals with route-level transitions. See [skills/view-transitions](../view-transitions/SKILL.md) for examples and the wrap-location rules across layouts, routes, and slots.

## Handler-attached `.use`

Page handlers can carry their own loader, middleware, error boundaries, parallels, and other defaults via a `.use` callback — so the page is self-contained and reusable across mount sites without re-wiring the same items.

```typescript
import { loader, loading, middleware, type Handler } from "@rangojs/router";

const ProductPage: Handler<"/product/:slug"> = async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductView product={product} />;
};
ProductPage.use = () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),
  middleware(async (ctx, next) => {
    await next();
    ctx.headers.set("Cache-Control", "private, max-age=60");
  }),
];

// Mount site has no per-page wiring — defaults travel with the handler.
path("/product/:slug", ProductPage, { name: "product" });
```

Explicit `use()` at the mount site merges with `handler.use` (handler defaults first, explicit second). See [skills/handler-use](../handler-use/SKILL.md) for the merge order, allowed item types per mount site, and override semantics.

## Complete Example

```typescript
import { urls, Breadcrumbs } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, loader, loading }) => [
  // Simple route
  path("/", HomePage, { name: "home" }),

  // Route with loader
  path("/about", AboutPage, { name: "about" }, () => [
    loader(TeamLoader),
  ]),

  // Dynamic route with handler
  path("/product/:slug", (ctx) => {
    const push = ctx.use(Breadcrumbs);
    push({ label: ctx.params.slug, href: `/product/${ctx.params.slug}` });
    return <ProductPage slug={ctx.params.slug} />;
  }, { name: "product" }, () => [
    loader(ProductLoader),
    loading(<ProductSkeleton />, { ssr: true }),
  ]),

  // Nested routes in layout
  layout(<BlogLayout />, () => [
    path("/blog", BlogIndex, { name: "blog.index" }),
    path("/blog/:slug", BlogPost, { name: "blog.post" }),
  ]),
]);
```
