---
name: route
description: Define routes with path() in @rangojs/router
argument-hint: [pattern]
---

# Defining Routes with path()

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

```typescript
path("/product/:slug", ProductPage, {
  name: "product", // Route name for href() and navigation
});
```

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
  // ctx.search is typed: { q: string; page?: number; sort?: string }
  const { q, page, sort } = ctx.search;
  // ctx.searchParams is always URLSearchParams
  return <SearchResults q={q} page={page} sort={sort} />;
};
```

Supported types: `"string"`, `"number"`, `"boolean"`, with `?` suffix for optional.
Missing params are `undefined` regardless of required/optional. The required/optional
distinction is a consumer-facing contract (for `href()` and `reverse()` autocomplete).

Use `RouteSearchParams<"name">` and `RouteParams<"name">` to extract types for props:

```typescript
import type { RouteSearchParams, RouteParams } from "@rangojs/router";

type SP = RouteSearchParams<"search">; // { q: string; page?: number; sort?: string }
type P = RouteParams<"blogPost">; // { slug: string }
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
via `ctx.get(key)`. Caching wraps all segments together, so either all run
or none do.

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

Only route handlers and middleware can call `ctx.set()`. Layouts, parallels,
and intercepts can only read via `ctx.get()`.

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

Reading a non-cacheable var inside `cache()` or `"use cache"` throws at
runtime. This prevents request-specific data from leaking into cached output:

```typescript
// This throws — Session is non-cacheable
async function CachedWidget(ctx) {
  "use cache";
  const session = ctx.get(Session); // Error: non-cacheable var read inside cache scope
  return <Widget />;
}
```

Cacheable vars (the default) can be read freely inside cache scopes.

### Revalidation Contracts for Handler Data

> **Scope: `revalidate()` is a partial-render concern, not a cache concern.**
> It decides whether this segment re-runs and streams to the client on a
> navigation or action — never whether a cached value is stale. The cache
> decides hit/miss/ttl/swr independently and never reads `revalidate()`. See
> `/cache-guide` → "Two axes" and `/rango` → "The shape of rango".

Handler-first guarantees apply within a single full render pass. For partial
action revalidation, define named revalidation contracts and reuse them on both
the producer route and the consumer child segments.

```typescript
// revalidation-contracts.ts
import * as CheckoutActions from "./actions/checkout";

// Defer (|| undefined), not ?? false: a hard `false` short-circuits the chain,
// so when the same segment composes multiple contracts the later ones never run.
export const revalidateCheckoutData = (ctx) =>
  ctx.isAction(CheckoutActions) || undefined;

path("/checkout", CheckoutPage, { name: "checkout" }, () => [
  revalidate(revalidateCheckoutData), // producer (route handler) reruns
  layout(CheckoutLayout, () => [
    revalidate(revalidateCheckoutData), // consumer reruns
    parallel({ "@summary": CheckoutSummary }, () => [
      revalidate(revalidateCheckoutData),
    ]),
  ]),
]);
```

If children depend on multiple upstream domains, compose multiple contracts on
the same segment (`revalidateAuthData`, `revalidateCheckoutData`, and so on).

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

### Basic redirect

```typescript
import { redirect } from "@rangojs/router";

path("/old-page", () => redirect("/new-page"), { name: "oldPage" });
```

### Redirect with custom status

```typescript
path("/moved", () => redirect("/new-location", 301), { name: "moved" });
```

> **Redirecting from a route with `loading()`:** an `async` handler that returns
> a `Response`/`redirect()` on a route that also declares `loading()` is streamed,
> so the redirect is rendered into the RSC stream instead of becoming an HTTP
> redirect. Issue the redirect from `middleware`, a loader, or a **synchronous**
> handler return instead. (Dev logs a warning if this is hit.)

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

Read the state on the target page with `useLocationState(FlashMessage)`. The
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
interface HandlerContext<TParams = {}, TEnv = DefaultEnv, TSearch = {}> {
  params: TParams; // URL parameters
  request: Request; // Original request
  searchParams: URLSearchParams; // Query params (always URLSearchParams)
  search: {} | ResolveSearchSchema<TSearch>; // Typed search params (from search schema)
  url: URL; // Parsed URL
  env: TEnv; // Environment (bindings + variables)
  set(key: string, value: any): void; // Set context variable (untyped string key)
  set<T>(contextVar: ContextVar<T>, value: T): void; // Set typed context variable
  get(key: string): any; // Read context variable (untyped string key)
  get<T>(contextVar: ContextVar<T>): T | undefined; // Read typed context variable
  use<T>(handle: Handle<T>): T; // Access handles
  reverse(
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ): string; // URL generation
  setLocationState(entries: LocationStateEntry[]): void; // Attach state to response
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

  // Access handles
  const breadcrumbs = ctx.use(Breadcrumbs);
  breadcrumbs.push({ label: "Product", href: `/product/${slug}` });

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

## View Transitions

A route can configure its own `transition()` — the wrap goes around the route's component itself (routes are leaves; they have no separate default outlet channel). If the route component renders a `<ParallelOutlet />` directly, that slot remains inside the route's VT subtree, so prefer mounting parallel slots in a layout when combining intercept modals with route-level transitions. See [skills/view-transitions](../view-transitions/SKILL.md) for examples and the wrap-location rules across layouts, routes, and slots.

## Handler-attached `.use`

Page handlers can carry their own loader, middleware, error boundaries, parallels, and other defaults via a `.use` callback — so the page is self-contained and reusable across mount sites without re-wiring the same items.

```typescript
const ProductPage: Handler<"/product/:slug"> = async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductView product={product} />;
};
ProductPage.use = () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),
  middleware(async (ctx, next) => {
    await next();
    ctx.header("Cache-Control", "private, max-age=60");
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
