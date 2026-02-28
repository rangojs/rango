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
  const product = await ctx.env.Bindings.DB.prepare(
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
  const results = await ctx.env.Bindings.DB.prepare(
    "SELECT * FROM products WHERE name LIKE ?",
  )
    .bind(`%${query}%`)
    .all();

  return { results: results.results ?? [] };
}, true); // true = fetchable
```

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
    await ctx.env.Bindings.BUCKET.put(file.name, file.stream());
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
