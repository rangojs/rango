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
  name: "product",  // Route name for href() and navigation
})
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

## Handler Context

Every handler receives a context object:

```typescript
interface HandlerContext<TParams = Record<string, string>> {
  params: TParams;           // URL parameters
  request: Request;          // Original request
  url: URL;                  // Parsed URL
  env: TEnv;                 // Environment (bindings + variables)
  use<T>(handle: Handle<T>): T;  // Access handles
}
```

### Using Context

```typescript
path("/product/:slug", (ctx) => {
  // Access URL params
  const { slug } = ctx.params;

  // Access query params
  const tab = ctx.url.searchParams.get("tab");

  // Access environment
  const db = ctx.env.Bindings.DB;

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
