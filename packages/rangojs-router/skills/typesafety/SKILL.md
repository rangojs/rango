---
name: typesafety
description: Set up type-safe routes, params, and environment types in @rangojs/router
argument-hint: [setup]
---

# Type Safety Setup

@rangojs/router provides end-to-end type safety for routes, parameters, and environment.

## Route Type Registration

Register route types globally for type-safe `href()` and params:

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});

// Extract route types for href()
export const href = router.href;

// Register globally via module augmentation
type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export default router;
```

## Route Definition with Type-Safe Names

```typescript
// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout }) => [
  path("/", HomePage, { name: "home" }),
  path("/products", ProductsPage, { name: "products" }),
  path("/product/:slug", ProductPage, { name: "product" }),
  path("/cart", CartPage, { name: "cart" }),
  path("/checkout/:step?", CheckoutPage, { name: "checkout" }),
]);

// Route names are inferred from the { name } option
```

## Type-Safe href()

After registration, `href()` has full autocomplete:

```typescript
import { href } from "./router";

// Autocomplete shows all registered route names
href("home");                          // "/"
href("products");                      // "/products"
href("product", { slug: "widget" });   // "/product/widget"

// TypeScript errors for:
href("invalid");                       // Error: not a valid route name
href("product");                       // Error: missing required param 'slug'
href("product", { wrong: "param" });   // Error: 'wrong' not in params
```

## Environment Type Setup

Define your app's environment for type-safe bindings and variables:

```typescript
// env.ts
import type { RouterEnv } from "@rangojs/router";

// Cloudflare bindings
interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
  CACHE: KVNamespace;
  AI: Ai;
}

// Variables set by middleware
interface AppVariables {
  user?: { id: string; email: string; role: string };
  requestId?: string;
  permissions?: string[];
}

// Combined environment type
export type AppEnv = RouterEnv<AppBindings, AppVariables>;
```

### Using Environment Types

```typescript
// router.tsx
import type { AppEnv } from "./env";

const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});

// middleware - typed ctx.env.Variables
import { createMiddleware } from "@rangojs/router";

export const authMiddleware = createMiddleware(async (ctx, next) => {
  ctx.env.Variables.user = { id: "123", email: "user@example.com", role: "admin" };
  await next();
});

// loaders - typed context
export const UserLoader = createLoader("user", async (ctx) => {
  const db = ctx.env.Bindings.DB;  // D1Database
  const userId = ctx.env.Variables.user?.id;
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
});
```

## Global Type Registration

Register environment types globally for implicit typing:

```typescript
// router.tsx
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
    interface Env extends AppEnv {}
  }
}
```

Now handlers have typed context without explicit imports:

```typescript
// In loaders
export const DashboardLoader = createLoader("dashboard", async (ctx) => {
  // ctx.env.Variables.user is typed from global Env
  // ctx.params is typed from route pattern
  const user = ctx.env.Variables.user;
  return { user };
});
```

## Loader Type Safety

Loaders have typed return values:

```typescript
// loaders/product.ts
export const ProductLoader = createLoader("product", async (ctx) => {
  return {
    id: ctx.params.slug,
    name: "Widget",
    price: 99,
  };
});

// In server component (handler) - use ctx.use()
async function ProductPage(ctx: HandlerContext) {
  const product = await ctx.use(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <h1>{product.name}</h1>;
}

// Register loader in route definition to expose to client
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),  // Required for useLoaderData in client components
])

// In client component - same type
"use client";
import { useLoaderData } from "@rangojs/router/client";

function ProductPrice() {
  const { product } = useLoaderData(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <span>${product.price}</span>;
}
```

**Note**: Loaders must be registered via `loader()` in route children (path, layout, parallel, intercept) to be accessible in client components via `useLoaderData`.

## Handle Type Safety

Handles have typed data:

```typescript
// handles/breadcrumbs.ts
import { createHandle } from "@rangojs/router";

// Simple handle - collects values into a flat array (default)
export const Breadcrumbs = createHandle<{ label: string; href: string }>();

// Handle with custom collect - transforms segment data into final value
// Receives array of segment arrays: [[parent values], [child values], ...]
export const PageTitle = createHandle<string, string>(
  (segments) => segments.flat().at(-1) ?? "My App"
);

// In handler - push data to handle via ctx.use()
async function ProductPage(ctx: HandlerContext) {
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  pushBreadcrumb({ label: "Products", href: "/shop/products" });

  const setTitle = ctx.use(PageTitle);
  setTitle("Product Details");

  return <ProductDetails />;
}

// In client component - read handle values
"use client";
function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // crumbs: Array<{ label: string; href: string }>
}

function DocumentTitle() {
  const title = useHandle(PageTitle);
  // title: string (reduced value)
}
```

## Location State Type Safety

```typescript
// location-states.ts
import { createLocationState } from "@rangojs/router";

export const ProductPreview = createLocationState<{
  name: string;
  price: number;
  image: string;
}>();

// Passing state through Link
<Link
  to={href("product", { slug: "widget" })}
  state={[ProductPreview({ name: "Widget", price: 99, image: "/img.jpg" })]}
>
  View Product
</Link>

// Reading state in component
function ProductHeader() {
  const preview = useLocationState(ProductPreview);
  // preview: { name: string; price: number; image: string } | undefined

  if (preview) {
    return <h1>{preview.name} - ${preview.price}</h1>;
  }
  return <h1>Loading...</h1>;
}
```

## Complete Type-Safe Setup

```typescript
// 1. env.ts - Environment types
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

// 2. urls.tsx - Route definitions with names
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, loader }) => [
  path("/", HomePage, { name: "home" }),

  layout(<ShopLayout />, () => [
    path("/shop", ShopIndex, { name: "shop" }),
    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader),
    ]),
  ]),
]);

// 3. router.tsx - Registration
const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
    interface Env extends AppEnv {}
  }
}

export default router;
export const href = router.href;

// 4. loaders/*.ts - Type-safe loaders
export const ProductLoader = createLoader("product", async (ctx) => {
  // ctx.params: { slug: string }
  // ctx.env.Variables.user: User | undefined
  // ctx.env.Bindings.DB: D1Database
  return { product: await fetchProduct(ctx.params.slug) };
});

// 5. components/*.tsx - Type-safe client code
<Link to={href("product", { slug: "widget" })}>Widget</Link>
```
