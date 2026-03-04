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
Required params default to zero values when missing (`""`, `0`, `false`).
Optional params are omitted from the result when not in the query string.

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

For scope/revalidation guarantees and non-guarantees, see:
[docs/execution-model.md](../../docs/internal/execution-model.md)

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
path("/dashboard", (ctx) => {
  ctx.setLocationState([ServerInfo({ data: "welcome" })]);
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

## Complete Example

```typescript
import { urls } from "@rangojs/router";
import { Breadcrumbs } from "./handles/breadcrumbs";

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
