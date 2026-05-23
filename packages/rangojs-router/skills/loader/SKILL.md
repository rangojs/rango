---
name: loader
description: Define data loaders for fetching data in routes with createLoader
argument-hint: [loader]
---

# Data Loaders with loader()

Loaders fetch data on the server and stream it to the client. For mutations
(writes triggered by forms or buttons), use server actions instead — see
`/server-actions`. Loaders re-resolve after an action runs, so the typical
flow is _action mutates → loader re-reads → UI updates_.

## Creating a Loader

```typescript
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  "use server";

  const product = await ctx.env.DB.prepare(
    "SELECT * FROM products WHERE slug = ?",
  )
    .bind(ctx.params.slug)
    .first();

  return { product };
});
```

### Supported export patterns

All of the following are equivalent and fully supported by the Vite transform:

```typescript
// Direct export (most common)
export const ProductLoader = createLoader(handler);

// Separate declaration + named export
const ProductLoader = createLoader(handler);
export { ProductLoader };

// Aliased export
const InternalLoader = createLoader(handler);
export { InternalLoader as ProductLoader };

// Aliased import
import { createLoader as cl } from "@rangojs/router";
export const ProductLoader = cl(handler);
```

The `export const` form and the `const + export { }` form both work for
client stubs, ID injection, and loader manifest tracking.

## Using Loaders in Routes

```typescript
import { urls } from "@rangojs/router";
import { ProductLoader } from "./loaders/product";

export const urlpatterns = urls(({ path, loader }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    loader(ProductLoader),
  ]),
]);
```

## Consuming Loader Data

Register loaders with `loader()` in the DSL and consume them in client
components with `useLoader()`. This is the recommended pattern — it keeps
data fetching on the server and consumption on the client, with a clean
separation that works correctly with `cache()`.

```typescript
"use client";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader } from "./loaders/product";

function ProductDetails() {
  const { data } = useLoader(ProductLoader);
  return <div>{data.product.description}</div>;
}
```

```typescript
// Route definition — loader() registration required
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
]);
```

DSL loaders are the **live data layer** — they resolve fresh on every
request, even when the route is inside a `cache()` boundary. The router
excludes them from the segment cache at storage time and re-resolves them
on retrieval. This means `cache()` gives you cached UI + fresh data by
default.

### Cache safety

DSL loaders can safely read `createVar({ cache: false })` variables
because they are always resolved fresh. The read guard is bypassed for
loader functions — they never produce stale data.

### ctx.use(Loader) — escape hatch

For cases where you need loader data in the server handler itself (e.g.,
to set ctx variables or make routing decisions), use `ctx.use(Loader)`:

```typescript
path("/product/:slug", async (ctx) => {
  const { product } = await ctx.use(ProductLoader);
  ctx.set(Product, product); // make available to children
  return <ProductPage />;
}, { name: "product" }, () => [
  loader(ProductLoader), // still register for client consumption
])
```

When you register with `loader()` in the DSL, `ctx.use()` returns the
same memoized result — loaders never run twice per request.

**Limitations of ctx.use(Loader):**

- The handler output depends on the loader data. If the route is inside
  `cache()`, the handler is cached with the loader result baked in —
  defeating the live data guarantee.
- Non-cacheable variable reads (`createVar({ cache: false })`) inside the
  handler still throw, even if the data came from a loader.
- Prefer DSL `loader()` + client `useLoader()` for data that depends on
  non-cacheable context variables.

**Never use `useLoader()` in server components** — it is a client-only API.

### Summary

| Pattern                | API                 | Cache-safe | Recommended |
| ---------------------- | ------------------- | ---------- | ----------- |
| DSL + client component | `useLoader(Loader)` | Yes        | Yes         |
| Handler escape hatch   | `ctx.use(Loader)`   | No         | When needed |

## Loader Context

Loaders receive the same context shape as route handlers.

### Full field surface

| Field          | Type                           | Notes                                                                                               |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `params`       | `TParams`                      | Merged route + explicit loader params; overridable by fetchable `load({ params })`.                 |
| `routeParams`  | `Record<string, string>`       | Server-trusted route params from URL pattern matching; cannot be overridden.                        |
| `request`      | `Request`                      | The incoming `Request` (headers, method, body, `signal` for abort).                                 |
| `url`          | `URL`                          | Parsed request URL.                                                                                 |
| `pathname`     | `string`                       | URL pathname (shortcut for `ctx.url.pathname`).                                                     |
| `searchParams` | `URLSearchParams`              | Shortcut for `ctx.url.searchParams`.                                                                |
| `search`       | `ResolveSearchSchema<TSearch>` | Typed query params when a search schema is declared on the route; `{}` otherwise.                   |
| `env`          | `TEnv`                         | Plain bindings from `createRouter<TEnv>()` (DB, KV, secrets, etc.).                                 |
| `get`          | `(key \| ContextVar) => value` | Reads variables/context-vars set by middleware.                                                     |
| `use`          | `(loader \| handle) => T`      | Access another loader's data (Promise) or a handle's collected data (after `await ctx.rendered()`). |
| `rendered`     | `() => Promise<void>`          | **Experimental.** DSL loaders only — waits for non-loader segments before reading handle data.      |
| `method`       | `string`                       | HTTP method. `"GET"` for SSR loader runs; reflects real method for fetchable loaders.               |
| `body`         | `TBody \| undefined`           | Parsed request body for fetchable POST/PUT/PATCH/DELETE calls.                                      |
| `formData`     | `FormData \| undefined`        | Present when a fetchable loader is invoked via form submission.                                     |
| `reverse`      | `ScopedReverseFunction`        | Generate type-checked URLs from route names (same scoped semantics as route handlers).              |

### Example

```typescript
export const ProductLoader = createLoader(async (ctx) => {
  "use server";

  // URL params (may include client-provided overrides for fetchable loaders)
  const { slug } = ctx.params;

  // Server-trusted route params (from URL pattern matching, cannot be overridden)
  const { slug: trustedSlug } = ctx.routeParams;

  // Query params
  const variant = ctx.url.searchParams.get("variant");

  // Platform bindings (DB, KV, etc.) — plain bindings from createRouter<TEnv>()
  const db = ctx.env.DB;

  // Request headers
  const auth = ctx.request.headers.get("Authorization");

  // Variables set by middleware (from Rango.Vars augmentation)
  const user = ctx.get("user");

  // Type-checked URLs for payloads. `.name` resolves within the current
  // include() scope; a bare `name` resolves globally. See /route and
  // /typesafety for scope rules and route-name autocomplete.
  const detailUrl = ctx.reverse(".detail", { slug });

  return {
    product: await fetchProduct(slug),
    links: { self: detailUrl },
  };
});
```

See `/route` for the full handler-context contract (shared with loaders) and
`/typesafety` for route-name typing that powers `ctx.reverse` autocomplete.

### params vs routeParams

- `ctx.params` — merged route params + explicit loader params. For fetchable
  loaders called with `load(Loader, { params: { ... } })`, explicit params
  override route-matched params.
- `ctx.routeParams` — server-trusted route params from URL pattern matching.
  Cannot be overridden by client-provided params.

Use `ctx.routeParams` when you need trusted route identity for authorization
or resource scoping:

```typescript
export const OrderLoader = createLoader(async (ctx) => {
  "use server";

  // Use routeParams for auth checks — client cannot spoof the URL-matched ID
  const { orderId } = ctx.routeParams;
  const user = ctx.get("user");

  const order = await db.orders.get(orderId);
  if (order.userId !== user.id)
    throw new Response("Forbidden", { status: 403 });

  return { order };
});
```

## Loader with Children

Add caching or revalidation to specific loaders:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Cached loader
  loader(ProductLoader, () => [cache({ ttl: 300 })]),

  // Loader with revalidation control
  loader(RelatedProductsLoader, () => [
    revalidate(() => false), // Never revalidate
  ]),

  // Loader that revalidates after cart actions (defer otherwise — keeps the
  // permissive loader defaults for navigation and other actions intact)
  loader(CartLoader, () => [
    revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),
  ]),
]);
```

### `revalidate()` return shapes

> **Scope: `revalidate()` is a partial-render concern, not a cache concern.**
> It decides whether a segment (here, a loader) re-runs and streams to the
> client on a navigation or action — never whether a cached value is stale. The
> cache decides hit/miss/ttl/swr independently and never reads `revalidate()`.
> Caching a loader is a separate, opt-in step (`loader(Fn, () => [cache({...})])`).
> See `/cache-guide` → "Two axes" and `/rango` → "The shape of rango".

A `revalidate(fn)` callback can return one of four shapes. The chain
processes revalidators in order; each call's return controls how the
chain continues:

```typescript
// 1) Hard decision — short-circuits the chain, used as the final answer.
revalidate(() => true);
revalidate(({ actionId }) => actionId?.includes("Cart") ?? false);

// 2) Soft decision — updates the running suggestion for downstream
//    revalidators on the same segment, chain continues.
revalidate(({ defaultShouldRevalidate }) => ({
  defaultShouldRevalidate: !defaultShouldRevalidate,
}));

// 3) Defer (no opinion) — leaves the running suggestion unchanged and
//    continues to the next revalidator. Implicit return / null /
//    undefined are all equivalent and consumer-friendly.
revalidate(({ actionId }) => {
  if (actionId?.includes("Cart")) return true; // hard for this branch only
  // implicit return — let downstream revalidators or the segment default decide
});
revalidate(() => undefined); // explicit defer
revalidate(() => null); // explicit defer
```

If every revalidator on a segment defers, the segment-type default
(e.g. params-changed for routes, `false` for parallels) is used.

#### `|| undefined` (defer) vs `?? false` (hard) — pick deliberately

A boolean return — including `false` — is a **hard** decision: it short-circuits
the chain and overrides the segment default. `undefined` **defers** to the
running suggestion / segment default. They are not interchangeable:

```typescript
// Defer: "revalidate on match, otherwise let the default/downstream decide."
revalidate(({ actionId }) => actionId?.includes("Cart") || undefined);

// Hard: "revalidate ONLY on match, suppress everything else."
revalidate(({ actionId }) => actionId?.includes("Cart") ?? false);
```

This matters most for loaders, whose defaults are permissive: a loader defaults
to revalidating on **any** action (`POST`) and on **param/search changes**
during navigation. So `?? false` on a loader silently suppresses both — the
loader will not refetch when you navigate to a different `:id`. Use
`|| undefined` when you want to _add_ a revalidation signal on top of the
sensible defaults, and reserve `?? false` for the rare case where you genuinely
want the loader to refetch on nothing but your matched action.

When **composing multiple revalidators** on one segment (see below), defer is
mandatory: the first hard `?? false` ends the chain and the later contracts
never run.

#### Matching actions: `ctx.isAction()`

To revalidate after specific server actions, match them by **reference** with
`ctx.isAction()` rather than hand-written `actionId` substrings. A rename or
moved file then becomes a type error instead of silently failing to match:

```typescript
import { addToCart, removeFromCart } from "../actions/cart";
import * as CartActions from "../actions/cart";

loader(CartLoader, () => [
  revalidate((ctx) => ctx.isAction(addToCart) || undefined), // one action
]);
revalidate((ctx) => ctx.isAction(addToCart, removeFromCart) || undefined); // several
revalidate((ctx) => ctx.isAction(CartActions) || undefined); // any action in the module
```

`isAction()` is a method on the revalidate predicate's **context argument** —
there is no standalone `isAction` import; you always reach it through the callback
parameter (`revalidate((ctx) => ctx.isAction(...))`). It returns a raw boolean, so
pair it with `|| undefined` for the usual "revalidate on match, else defer"
intent. It returns `false` on plain navigation and on non-matches, and resolves
the reference the same way the router derives `actionId` (`$id` in production,
`$$id` in dev), so it matches in both modes. The raw `actionId` string stays
available on the same context as an escape hatch.

### Revalidation Contracts for Loader Dependencies

If a loader reads `ctx.get()` data produced by an outer handler/layout, share
the same named revalidation contract across producer and consumer segments.

```typescript
// revalidation-contracts.ts
import * as AccountActions from "./actions/account";

// Match by reference with ctx.isAction() (rename-safe), and defer (|| undefined)
// so these contracts compose — a hard `false` would short-circuit the rest.
export const revalidateAccountScope = (ctx) =>
  ctx.isAction(AccountActions) || undefined;

layout(AccountLayout, () => [
  revalidate(revalidateAccountScope), // producer reruns
  path("/account/orders", OrdersPage, { name: "account.orders" }, () => [
    loader(OrdersLoader, () => [
      revalidate(revalidateAccountScope), // consumer reruns
    ]),
  ]),
]);
```

For segments that depend on multiple upstream domains, compose multiple
contracts on both sides.

To keep loader route trees concise, export helper wrappers:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateAccount = () => [revalidate(revalidateAccountScope)];

layout(AccountLayout, () => [
  revalidateAccount(),
  path("/account/orders", OrdersPage, { name: "account.orders" }, () => [
    loader(OrdersLoader, () => [revalidateAccount()]),
  ]),
]);
```

## Loaders: The Live Data Layer

Loaders are the live data layer of the router. They resolve fresh on every
request, even when the route's UI segments are served from cache. This is a
core design principle — route-level `cache()` caches rendered components but
never caches loader data. Loaders are excluded at storage time and re-resolved
on retrieval.

This means `cache()` gives you cached UI + fresh data by default. Pre-rendering
follows the same rule: at build time, loaders are skipped entirely (there is no
real request context), and at runtime the worker resolves them fresh against
the live database.

### Parallel and streaming — latency overlaps first paint

Loaders do not block the page. As the render pass begins — the pass that route
middleware wraps, so loaders run right after middleware, not in a later
phase — every matched loader is kicked off **concurrently** (their promises start in the
same tick), and each result is **streamed** to the client as its own RSC Flight
chunk rather than awaited up front. Pair a loader with `loading()` (or a
client `<Suspense>`) and the shell paints immediately while the data streams in.

This is why **"cached UI still pays full data latency" is the wrong intuition**:
on a `cache()` hit the UI segments stream instantly from cache while the live
loaders resolve fresh **in parallel** — data latency _overlaps_ first paint
instead of being added on top of it. (Without a `loading()` / `<Suspense>`
boundary a parallel loader blocks its parent, so add one to keep the overlap.)

If you come from a framework where the loader is a blocking step that runs
before the response is built, this is the shift to internalize: here the
response starts streaming first and loader data fills in.

### See it: `debugPerformance`

Turn on the per-request performance timeline early — it is the fastest way to
confirm loaders overlap rather than serialize, and to find the real bottleneck
locally instead of guessing:

```typescript
const router = createRouter({ document: Document, debugPerformance: true });
```

Or enable it per-request from middleware (e.g. only when `?debug` is present) by
calling `ctx.debugPerformance()` **before** `await next()`. Each HTML request
then prints a shared-axis waterfall (and emits a `Server-Timing` header):

```
[RSC Perf] GET /product/widget (24.53ms)
start      dur  span                          timeline
 0.08ms  3.20ms  route-matching               |#####...................................|
 3.40ms  8.70ms  ssr-render-html              |.....##############.....................|
 3.42ms 11.90ms  loader:…#ProductLoader       |.....###################................|
 3.45ms 11.40ms  loader:…#ReviewsLoader        |.....##################.................|
 0.00ms 24.53ms  handler:total                |########################################|
```

How to read it:

- **Humans:** scan the `#` bars on the shared axis. Bars that start at the same
  offset and run side by side are executing **in parallel** — loaders should
  overlap `ssr-render-html` / `render:total`, not sit alone to the right of
  everything. A lone `loader:*` bar past the render bar is serialized latency to
  chase. `handler:total` is the whole request; `render:total` is the render pass.
- **LLMs / programmatic:** read each row as `{ start, dur, label }`. A loader
  overlaps paint when its `[start, start+dur]` interval intersects
  `render:total` / `ssr-render-html`. Flag a regression when a `loader:*`
  interval is **disjoint from and starts after** `render:total`, or when its
  `dur` approaches `handler:total` — that loader is on the critical path instead
  of overlapping it. Two `loader:*` rows with near-equal `start` confirm
  parallel execution.

### Opting a Loader into Caching

To cache a specific loader's data, attach a `cache()` child:

```typescript
loader(ProductLoader, () => [cache({ ttl: 300 })]),
```

The loader's data is cached independently from the route's segment cache,
using the same `SegmentCacheStore` (app-level or per-loader override).

Values are serialized through RSC Flight, so loaders can return ReactNode,
Promises, null, and any RSC-serializable type — all round-trip correctly
through the cache.

### Cache Key

The default cache key is `loader:{loaderId}:{pathname}:{sortedParams}`.
This can be customized at two levels:

```typescript
// Full override — key function replaces the default entirely
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    key: (ctx) => `product:${ctx.params.slug}:${cookies().get("locale")?.value ?? "en"}`,
  }),
]),

// Store-level keyGenerator — modifies the default key (e.g., adds a region prefix)
// Set in the store configuration, applies to all entries in that store
```

Resolution priority (same as route-level `cache()`):

1. `key(ctx)` from cache options — full override
2. `store.keyGenerator(ctx, defaultKey)` — store-level modification
3. Default key — `loader:{id}:{pathname}:{params}`

If a custom key function throws, it falls back to the default key silently
(logged to console.error).

### Tags for Invalidation

```typescript
// Static tags
loader(ProductLoader, () => [
  cache({ ttl: 300, tags: ["products", "catalog"] }),
]),

// Dynamic tags
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    tags: (ctx) => [`product:${ctx.params.slug}`, "products"],
  }),
]),
```

### Stale-While-Revalidate

```typescript
loader(ProductLoader, () => [
  cache({ ttl: 60, swr: 300 }),
]),
```

During the SWR window (60-360s), stale data is returned immediately while
fresh data is fetched in the background via `waitUntil`. After the SWR window
expires (360s+), the entry is treated as a cache miss.

### Conditional Caching

Skip the cache at runtime based on request properties:

```typescript
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    condition: (ctx) => !ctx.request.headers.has("authorization"),
  }),
]),
```

When `condition` returns false, the loader runs fresh and the cache is bypassed
entirely (no read, no write).

### Per-Loader Store Override

```typescript
const hotStore = new MemorySegmentCacheStore({ defaults: { ttl: 10 } });

loader(PricingLoader, () => [
  cache({ store: hotStore }),
]),
```

Without an explicit store, the loader uses the app-level store from the
handler config (`cache.store`).

## Multiple Loaders

Routes can have multiple loaders that run in parallel:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loader(RelatedProductsLoader),
  loader(ReviewsLoader),
]);
```

## Layout Loaders

Loaders on layouts are shared by all child routes:

```typescript
layout(<ShopLayout />, () => [
  // These loaders are available to all shop routes
  loader(CartLoader),
  loader(CategoriesLoader),

  path("/shop", ShopIndex, { name: "index" }),
  path("/shop/product/:slug", ProductPage, { name: "product" }),
])
```

## Passing Loaders as Props

Loaders can be passed as props from server to client components. RSC serialization
uses `toJSON()` to send only `{ __brand, $$id }` — the loader function is stripped.

```typescript
// Server component (route handler)
import { SlowLoader } from "../loaders";

path("/dashboard", () => <DashboardContent loader={SlowLoader} />, { name: "dashboard" }, () => [
  loader(SlowLoader),
  loading(<DashboardSkeleton />),
])

// Client component — use typeof for type-safe props
"use client";
import { useLoader } from "@rangojs/router/client";
import type { SlowLoader } from "../loaders";

function DashboardContent({ loader }: { loader: typeof SlowLoader }) {
  const { data } = useLoader(loader);
  return <div>{data.message}</div>;
}
```

Use `typeof MyLoader` for the prop type — it infers the full generic automatically.

## Streaming with Suspense

Loaders stream data. Use Suspense for loading states:

```typescript
// In route definition
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),  // Shows while loader streams
])

// Or in component
function ProductPage() {
  return (
    <Suspense fallback={<ProductSkeleton />}>
      <ProductDetails />
    </Suspense>
  );
}
```

## Fetchable Loaders

By default, loaders only run during SSR and navigation. Pass `true` as the second
argument to `createLoader` to make a loader **fetchable** — callable from the client
via `useFetchLoader()` and `load()`:

```typescript
import { createLoader } from "@rangojs/router";

export const SearchLoader = createLoader(async (ctx) => {
  "use server";

  const query = ctx.params.query ?? "";
  const results = await ctx.env.DB.prepare(
    "SELECT * FROM products WHERE name LIKE ?",
  )
    .bind(`%${query}%`)
    .all();

  return { results: results.results ?? [] };
}, true); // true = fetchable
```

### Fetchable Loader with Middleware

Pass an options object instead of `true` to attach per-loader middleware.
This middleware runs only on `_rsc_loader` fetch requests (client-side
`load()` / `useFetchLoader()` calls), not during SSR `ctx.use()` execution:

```typescript
import { createLoader } from "@rangojs/router";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";

export const ProtectedLoader = createLoader(
  async (ctx) => {
    "use server";

    const user = ctx.get("user");
    return { orders: await db.orders.list(user.id) };
  },
  { middleware: [authMiddleware, rateLimitMiddleware] },
);
```

The middleware uses the same `MiddlewareFn` signature as route/app middleware,
so you can reuse existing middleware functions directly.

Fetchable loaders support both GET and POST (PUT, PATCH, DELETE) from the client.
The `load()` function auto-detects the body type:

- **JSON body** (`body: { ... }`) — sent as `application/json`, available as `ctx.body`
- **FormData body** (`body: formData`) — sent as `multipart/form-data`, available as `ctx.formData`

### Mutation Context

When a fetchable loader receives a POST/PUT/PATCH/DELETE request, the context
includes additional fields depending on the body type:

```typescript
export const MutationLoader = createLoader(async (ctx) => {
  "use server";

  // JSON body — available as ctx.body (parsed object)
  const data = ctx.body as { name: string; email: string };

  // FormData body — available as ctx.formData
  const file = ctx.formData?.get("file") as File | null;
  const name = ctx.formData?.get("name") as string | null;

  // Route params are always available
  const { slug } = ctx.params;

  return { success: true };
}, true);
```

### File Upload Example

```typescript
// loaders/upload.ts
import { createLoader } from "@rangojs/router";

export const FileUploadLoader = createLoader(async (ctx) => {
  "use server";

  const file = ctx.formData?.get("file") as File | null;
  if (file && file.size > 0) {
    // Save to R2, D1, etc.
    await ctx.env.BUCKET.put(file.name, file.stream());
    return { uploaded: { name: file.name, size: file.size, type: file.type } };
  }
  return { uploaded: null };
}, true);
```

Client usage — see `/hooks useFetchLoader` for the full client-side pattern.

> **Refetch sharing**: when the loader is registered on the route via
> `loader()`, a plain `load()` call (no `params`, no `body`) broadcasts
> the new value to every component reading the same loader id —
> `useLoader` reads in layouts, pages, and parallel slots all converge.
> Calls with `params` or a non-GET method stay local to the call site.
> See `/hooks` → "Shared refetch behavior" for the full contract.

## Complete Example

```typescript
// loaders/shop.ts
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  "use server";

  const product = await ctx.env.DB
    .prepare("SELECT * FROM products WHERE slug = ?")
    .bind(ctx.params.slug)
    .first();

  if (!product) {
    notFound("Product not found");
  }

  return { product };
});

export const CartLoader = createLoader(async (ctx) => {
  "use server";

  const user = ctx.get("user");
  if (!user) return { cart: null };

  const cart = await ctx.env.KV.get(`cart:${user.id}`, "json");
  return { cart };
});

// urls.tsx — register loaders in the DSL
export const urlpatterns = urls(({ path, layout, loader, loading, cache, revalidate }) => [
  layout(<ShopLayout />, () => [
    loader(CartLoader, () => [
      revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),
    ]),

    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [cache({ ttl: 60 })]),
      loading(<ProductSkeleton />),
    ]),
  ]),
]);

// components/ProductDetails.tsx — consume in client component
"use client";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader, CartLoader } from "./loaders/shop";

function ProductDetails() {
  const { data: { product } } = useLoader(ProductLoader);
  const { data: { cart } } = useLoader(CartLoader);

  return (
    <div>
      <h1>{product.name}</h1>
      <AddToCartButton
        productId={product.id}
        inCart={cart?.items.includes(product.id)}
      />
    </div>
  );
}
```
