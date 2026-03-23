---
name: loader
description: Define data loaders for fetching data in routes with createLoader
argument-hint: [loader]
---

# Data Loaders with loader()

Loaders fetch data on the server and stream it to the client.

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

Loaders receive the same context as route handlers:

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

  // Variables set by middleware (from RSCRouter.Vars augmentation)
  const user = ctx.get("user");

  return { product: await fetchProduct(slug) };
});
```

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

  // Loader that revalidates after cart actions
  loader(CartLoader, () => [
    revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
  ]),
]);
```

### Revalidation Contracts for Loader Dependencies

If a loader reads `ctx.get()` data produced by an outer handler/layout, share
the same named revalidation contract across producer and consumer segments.

```typescript
// revalidation-contracts.ts
export const revalidateAccountScope = ({ actionId }) =>
  actionId?.includes("src/actions/account.ts#") ?? false;

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
    throw new Response("Product not found", { status: 404 });
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
      revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
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
