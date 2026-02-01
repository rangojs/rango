---
name: typesafety
description: Set up type-safe routes, params, and environment types in rsc-router
argument-hint: [setup]
---

# Type Safety Setup

rsc-router provides end-to-end type safety for routes, parameters, and environment.

## Route Type Registration

Register route types globally for type-safe `href()` and params:

```typescript
// router.tsx
import { createRSCRouter } from "rsc-router/server";
import { homeRoutes } from "./routes/home";
import { shopRoutes } from "./routes/shop";

const _router = createRSCRouter<AppEnv>({ document: Document })
  .routes(homeRoutes)
  .map(() => import("./handlers/home"))
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop"));

// Extract accumulated route types
type AppRoutes = typeof _router.routeMap;

// Register globally via module augmentation
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export default _router;
export const href = _router.href;
```

## Route Definition with Type-Safe Keys

```typescript
// routes/shop.ts
import { route } from "rsc-router";

export const shopRoutes = route({
  "shop.index": "/",
  "shop.products": "/products",
  "shop.product": "/products/:slug",
  "shop.cart": "/cart",
  "shop.checkout": "/checkout/:step?",
});

// Type is inferred:
// {
//   "shop.index": "/",
//   "shop.products": "/products",
//   "shop.product": "/products/:slug",
//   ...
// }
```

## Type-Safe href()

After registration, `href()` has full autocomplete:

```typescript
import { href } from "./router";

// Autocomplete shows all registered routes
href("shop.index");                          // "/shop"
href("shop.products");                       // "/shop/products"
href("shop.product", { slug: "widget" });    // "/shop/products/widget"

// TypeScript errors for:
href("invalid.route");                       // Error: not a valid route
href("shop.product");                        // Error: missing required param 'slug'
href("shop.product", { wrong: "param" });    // Error: 'wrong' not in params
```

## Type-Safe Params in Handlers

Params are automatically typed based on route patterns:

```typescript
// handlers/shop.tsx
import { map } from "rsc-router/server";
import type { shopRoutes } from "../routes/shop";

export default map<typeof shopRoutes>(({ route }) => [
  // ctx.params is typed as { slug: string }
  route("shop.product", (ctx) => {
    const { slug } = ctx.params;  // TypeScript knows slug exists
    return <ProductPage slug={slug} />;
  }),

  // ctx.params is typed as { step?: string }
  route("shop.checkout", (ctx) => {
    const step = ctx.params.step ?? "shipping";  // Optional param
    return <CheckoutPage step={step} />;
  }),
]);
```

## Environment Type Setup

Define your app's environment for type-safe bindings and variables:

```typescript
// env.ts
import type { RouterEnv } from "rsc-router/server";

// Cloudflare bindings
interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
  CACHE: KVNamespace;
  AI: Ai;
}

// Variables set by middleware (ctx.set/ctx.get)
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

const router = createRSCRouter<AppEnv>({ document: Document })
  // ...

// middleware - typed ctx.set/ctx.get
const authMiddleware = async (ctx: MiddlewareContext<AppEnv>, next) => {
  ctx.set("user", { id: "123", email: "user@example.com", role: "admin" });
  await next();
};

// handlers - typed access
route("dashboard", (ctx) => {
  const user = ctx.get("user");  // { id: string; email: string; role: string } | undefined
  const db = ctx.env.Bindings.DB;  // D1Database
  return <Dashboard user={user} />;
});

// loaders - typed context
export const UserLoader = createLoader<AppEnv>(async (ctx) => {
  const db = ctx.env.Bindings.DB;
  const userId = ctx.get("user")?.id;
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
// handlers/dashboard.tsx - no type imports needed
export default map(({ route }) => [
  route("dashboard", (ctx) => {
    // ctx.get("user") is typed from global Env
    // ctx.params is typed from global RegisteredRoutes
    const user = ctx.get("user");
    return <Dashboard user={user} />;
  }),
]);
```

## Route Key Conflict Detection

TypeScript detects duplicate keys with different URL patterns:

```typescript
// This causes a type error:
const router = createRSCRouter<AppEnv>({ document: Document })
  .routes({ index: "/" })
  .map(() => import("./home"))
  .routes({ index: "/other" })  // Error! 'index' already exists with different pattern
  .map(() => import("./other"));

// Error message:
// Property 'map' does not exist on type '{
//   __error: "Route key conflict! Keys [index] already exist with different URL patterns.";
//   hint: "Use unique key names for each route definition.";
// }'
```

### Avoiding Conflicts

Use namespaced keys:

```typescript
// Good - unique keys
export const homeRoutes = route({ "home.index": "/" });
export const blogRoutes = route({ "blog.index": "/", "blog.post": "/:slug" });

// router.tsx
.routes(homeRoutes)
.map(() => import("./home"))
.routes("/blog", blogRoutes)  // Keys stay: blog.index, blog.post
.map(() => import("./blog"))  // URLs become: /blog/, /blog/:slug
```

## Loader Type Safety

Loaders have typed return values:

```typescript
// loaders/product.ts
export const ProductLoader = createLoader(async (ctx) => {
  return {
    id: ctx.params.slug,
    name: "Widget",
    price: 99,
  };
});

// In handler - type is inferred
route("shop.product", async (ctx) => {
  const product = await ctx.use(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <ProductPage product={product} />;
});

// In client component - same type
function ProductPrice() {
  const { data } = useLoader(ProductLoader);
  // data: { id: string; name: string; price: number }
  return <span>${data.price}</span>;
}
```

## Handle Type Safety

Handles have typed data:

```typescript
// handles/breadcrumbs.ts
import { createHandle } from "rsc-router";

export const Breadcrumbs = createHandle<{ label: string; href: string }>();

// In handler - typed push
route("shop.product", (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Products", href: "/shop/products" });  // Typed
  push({ wrong: "data" });  // Error!
  return <ProductPage />;
});

// In client - typed array
function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // crumbs: Array<{ label: string; href: string }>
}
```

## Location State Type Safety

```typescript
// location-states.ts
import { createLocationState } from "rsc-router";

export const ProductPreview = createLocationState<{
  name: string;
  price: number;
  image: string;
}>();

// Passing state through Link
<Link
  to={href("shop.product", { slug: "widget" })}
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

// 2. routes/*.ts - Route definitions
export const shopRoutes = route({
  "shop.index": "/",
  "shop.product": "/products/:slug",
});

// 3. router.tsx - Registration
const _router = createRSCRouter<AppEnv>({ document: Document })
  .routes(shopRoutes)
  .map(() => import("./handlers/shop"));

type AppRoutes = typeof _router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
    interface Env extends AppEnv {}
  }
}

export default _router;
export const href = _router.href;

// 4. handlers/*.tsx - Type-safe handlers
export default map<typeof shopRoutes>(({ route }) => [
  route("shop.product", (ctx) => {
    // ctx.params: { slug: string }
    // ctx.get("user"): User | undefined
    // ctx.env.Bindings.DB: D1Database
  }),
]);

// 5. components/*.tsx - Type-safe client code
<Link to={href("shop.product", { slug: "widget" })}>Widget</Link>
```
