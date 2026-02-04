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

### In Server Components (Handlers)

```typescript
import { ProductLoader } from "./loaders/product";

async function ProductPage(ctx: HandlerContext) {
  const { product } = await ctx.use(ProductLoader);
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

**Note**: For `useLoaderData` to work, the loader must be registered in the route definition using the `loader()` DSL function (in path, layout, parallel, or intercept children).

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
import { ProductLoader, CartLoader } from "./loaders/shop";

async function ProductPage(ctx: HandlerContext) {
  const { product } = await ctx.use(ProductLoader);
  const { cart } = await ctx.use(CartLoader);

  return (
    <div>
      <h1>{product.name}</h1>
      <AddToCartButton productId={product.id} inCart={cart?.items.includes(product.id)} />
    </div>
  );
}
```
