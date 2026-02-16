---
name: loader
description: Define data loaders for fetching data in routes with createLoader
argument-hint: [name]
---

# Data Loaders with loader()

Loaders fetch data on the server and stream it to the client.

## Creating a Loader

```typescript
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader("product", async (ctx) => {
  const product = await ctx.env.Bindings.DB
    .prepare("SELECT * FROM products WHERE slug = ?")
    .bind(ctx.params.slug)
    .first();

  return { product };
});
```

### Supported export patterns

All of the following are equivalent and fully supported by the Vite transform:

```typescript
// Direct export (most common)
export const ProductLoader = createLoader("product", handler);

// Separate declaration + named export
const ProductLoader = createLoader("product", handler);
export { ProductLoader };

// Aliased export
const InternalLoader = createLoader("product", handler);
export { InternalLoader as ProductLoader };

// Aliased import
import { createLoader as cl } from "@rangojs/router";
export const ProductLoader = cl("product", handler);
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

### In Server Components

```typescript
import { useLoader } from "@rangojs/router";
import { ProductLoader } from "./loaders/product";

async function ProductPage() {
  const { product } = await useLoader(ProductLoader);
  return <h1>{product.name}</h1>;
}
```

### In Client Components

```typescript
"use client";
import { useLoaderData } from "@rangojs/router/client";
import { ProductLoader } from "./loaders/product";

function ProductDetails() {
  const { product } = useLoaderData(ProductLoader);
  return <div>{product.description}</div>;
}
```

## Loader Context

Loaders receive the same context as route handlers:

```typescript
export const ProductLoader = createLoader("product", async (ctx) => {
  // URL params
  const { slug } = ctx.params;

  // Query params
  const variant = ctx.url.searchParams.get("variant");

  // Environment (DB, KV, etc.)
  const db = ctx.env.Bindings.DB;

  // Request headers
  const auth = ctx.request.headers.get("Authorization");

  // Variables set by middleware
  const user = ctx.env.Variables.user;

  return { product: await fetchProduct(slug) };
});
```

## Loader with Children

Add caching or revalidation to specific loaders:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Cached loader
  loader(ProductLoader, () => [
    cache({ ttl: 300 }),
  ]),

  // Loader with revalidation control
  loader(RelatedProductsLoader, () => [
    revalidate(() => false),  // Never revalidate
  ]),

  // Loader that revalidates after cart actions
  loader(CartLoader, () => [
    revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
  ]),
])
```

## Multiple Loaders

Routes can have multiple loaders that run in parallel:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loader(RelatedProductsLoader),
  loader(ReviewsLoader),
])
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

## Client Loaders

Client loaders run only in the browser during SPA navigation. They access
browser-only APIs (localStorage, cookies, IndexedDB) without server round-trips.
During SSR, the `loading()` skeleton shows instead.

### createClientLoader

```typescript
import { createClientLoader } from "@rangojs/router";

export const ThemeLoader = createClientLoader(async (ctx) => {
  // ctx has: params, searchParams, pathname, url, signal, segments, state
  const saved = localStorage.getItem("theme");
  return { theme: saved ?? "light", source: "client" as const };
});
```

### ClientLoaderContext

Client loaders receive a `ClientLoaderContext`:

```typescript
type ClientLoaderContext = {
  params: Record<string, string | undefined>;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  signal: AbortSignal;
  segments: readonly string[];        // e.g., ["shop", "products", "123"]
  state: Record<string, unknown> | null; // resolved navigation state from history.state
};
```

Use `state` to access data passed via `<Link state={[...]}>`  or `navigate(url, { state })`:

```typescript
import { createClientLoader, createLocationState } from "@rangojs/router";

const ProductState = createLocationState<{ name: string; price: number }>();

export const ProductPreviewLoader = createClientLoader(async (ctx) => {
  // Access navigation state passed via Link or navigate()
  if (ctx.state) {
    const preview = ctx.state.__rsc_ls_ProductState;
    if (preview) return { product: preview, source: "state" as const };
  }
  // Fallback: fetch from API
  const slug = ctx.params.slug;
  const res = await fetch(`/api/product/${slug}`);
  return { product: await res.json(), source: "fetch" as const };
});
```

Use `segments` for conditional logic based on URL structure:

```typescript
export const BreadcrumbLoader = createClientLoader(async (ctx) => {
  // ctx.segments for /shop/products/123 is ["shop", "products", "123"]
  return { depth: ctx.segments.length, parts: ctx.segments };
});
```

### createIsomorphicLoader

Isomorphic loaders have both a server function (SSR) and a client function (SPA):

```typescript
import { createIsomorphicLoader } from "@rangojs/router";

export const CartLoader = createIsomorphicLoader(
  // Server fn: runs during SSR
  async (ctx) => {
    const cart = await ctx.env.Bindings.KV.get(`cart:${ctx.env.Variables.user?.id}`, "json");
    return { items: cart?.items ?? [], source: "server" as const };
  },
  // Client fn: runs during SPA navigation
  async (ctx) => {
    const res = await fetch("/api/cart");
    const cart = await res.json();
    return { items: cart.items, source: "client" as const };
  },
);
```

### Using Client/Isomorphic Loaders in Routes

Register them the same way as server loaders with `loader()`. Always add a
`loading()` fallback since client loaders don't run during SSR:

```typescript
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  loader(ThemeLoader),
  loader(CartLoader),
  loading(<DashboardSkeleton />),
])
```

### Mixing Server and Client Loaders

A single route can use both server and client loaders:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductDetailsLoader),  // server loader
  loader(UserPrefsLoader),       // client loader
  loading(<ProductSkeleton />),
])
```

## Complete Example

```typescript
// loaders/shop.ts
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader("product", async (ctx) => {
  const product = await ctx.env.Bindings.DB
    .prepare("SELECT * FROM products WHERE slug = ?")
    .bind(ctx.params.slug)
    .first();

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  return { product };
});

export const CartLoader = createLoader("cart", async (ctx) => {
  const user = ctx.env.Variables.user;
  if (!user) return { cart: null };

  const cart = await ctx.env.Bindings.KV.get(`cart:${user.id}`, "json");
  return { cart };
});

// urls.tsx
export const urlpatterns = urls(({ path, layout, loader, loading, cache, revalidate }) => [
  layout(<ShopLayout />, () => [
    // Shared cart loader for all shop routes
    loader(CartLoader, () => [
      revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
    ]),

    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [cache({ ttl: 60 })]),
      loading(<ProductSkeleton />),
    ]),
  ]),
]);

// pages/product.tsx
import { useLoader } from "@rangojs/router";
import { ProductLoader, CartLoader } from "./loaders/shop";

async function ProductPage() {
  const { product } = await useLoader(ProductLoader);
  const { cart } = await useLoader(CartLoader);

  return (
    <div>
      <h1>{product.name}</h1>
      <AddToCartButton productId={product.id} inCart={cart?.items.includes(product.id)} />
    </div>
  );
}
```
