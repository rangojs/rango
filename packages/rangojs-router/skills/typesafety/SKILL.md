---
name: typesafety
description: Set up type-safe routes, params, and environment types in @rangojs/router
argument-hint: [setup]
---

# Type Safety Setup

@rangojs/router provides end-to-end type safety for routes, parameters, and environment.

## Router Setup

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});

// Server-side named-route reverse (type-safe via routeMap)
export const reverse = router.reverse;

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

### Server: ctx.reverse with route names

In route handlers, `ctx.reverse()` resolves names in this order:
1. **Path-based** (`/...`) — returned as-is
2. **Dot-prefixed** (`.author.posts`) — strictly local, no global fallback
3. **Unprefixed** (`cart`, `author.posts`) — local first, then global fallback

```typescript
import type { Handler } from "@rangojs/router";

export const ProductHandler: Handler<"shop.product"> = (ctx) => {
  ctx.reverse("cart");                                   // Local: shop.cart
  ctx.reverse("product", { slug: "widget" });            // Local: shop.product
  ctx.reverse("blog.post", { postId: "1" });             // Global fallback: blog.post
};

// Dot-prefixed names guarantee local resolution (like "./" in file paths):
export const MagazineAuthorHandler: Handler<"magazine.author"> = (ctx) => {
  ctx.reverse(".article", { slug: "design" });           // Strictly local: magazine.article
  ctx.reverse(".author.posts", { authorSlug: "alice" }); // Strictly local: magazine.author.posts
  ctx.reverse(".blog.index");                            // THROWS — no magazine.blog.index

  // Without dot prefix — local first, global fallback:
  ctx.reverse("author.posts", { authorSlug: "alice" });  // Local: magazine.author.posts
  ctx.reverse("blog.index");                             // Global: blog.index
};
```

For opt-in per-module isolation (after running `npx rango generate urls/shop.tsx`),
use `scopedReverse()` with a local route map:

```typescript
import { scopedReverse } from "@rangojs/router";
import type { routes } from "./shop.gen.js";

export const ProductHandler: Handler<"product", routes> = (ctx) => {
  const reverse = scopedReverse<routes>(ctx.reverse);
  reverse("cart");                        // Local name
  reverse("product", { slug: "widget" }); // Local with params
};
```

### Client: href + useHref

On the client, `href()` validates paths against registered route patterns at compile time:

```typescript
"use client";
import { href, useHref, Link } from "@rangojs/router/client";

// href() validates absolute paths via PatternToPath types
href("/about");                        // Valid path
href("/blog/hello");                   // Matches /blog/:slug

// useHref() auto-prefixes with include() mount
function ShopNav() {
  const href = useHref();
  return <Link to={href("/cart")}>Cart</Link>; // "/shop/cart"
}
```

See `/links` for full URL generation guide.

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

## Global Environment Registration

Register environment types globally for implicit typing:

```typescript
// router.tsx
declare global {
  namespace RSCRouter {
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

## Typed Search Params

Add a `search` schema to `path()` options for type-safe query parameters:

```typescript
// Route definition with search schema
path("/search", SearchPage, {
  name: "search",
  search: { q: "string", page: "number?", sort: "string?" },
})
```

### Handler with typed search params

`Handler<"name">` automatically resolves route params and search params from the
global `GeneratedRouteMap` (the gen file). No explicit route map import needed:

```typescript
// pages/search.tsx
import type { Handler } from "@rangojs/router";

export const SearchPage: Handler<"search"> = (ctx) => {
  // ctx.searchParams is typed: { q: string; page?: number; sort?: string }
  const { q, page, sort } = ctx.searchParams;
  return <SearchResults q={q} page={page} sort={sort} />;
};
```

This avoids circular references because `Handler` defaults to `GeneratedRouteMap`
(from `router.named-routes.gen.ts`) instead of `RegisteredRoutes` (which depends on `router.tsx`).

You can also pass an explicit route map for per-module isolation (opt-in,
after running `npx rango generate`):

```typescript
import type { Handler } from "@rangojs/router";
import type { routes } from "./urls.gen.js";

export const SearchPage: Handler<"search", routes> = (ctx) => { ... };
```

Supported types: `"string"`, `"number"`, `"boolean"`, with `?` suffix for optional.
Values are automatically coerced from query string (e.g., `"2"` becomes `2` for numbers).
Routes without a `search` schema keep the standard `URLSearchParams` behavior.

### RouteSearchParams and RouteParams utility types

Extract typed params by route name for use in component props, return types, or anywhere:

```typescript
import type { RouteSearchParams, RouteParams } from "@rangojs/router";

// RouteSearchParams<"name"> resolves the search schema to a typed object
type SP = RouteSearchParams<"search">;
// { q: string; page?: number; sort?: string }

// RouteParams<"name"> resolves URL params from the route pattern
type P = RouteParams<"blogPost">;
// { slug: string }

// Use in component props
interface SearchResultsProps {
  params: RouteSearchParams<"search">;
}
```

Both default to the global route map (`RegisteredRoutes` or `GeneratedRouteMap`).
Pass an explicit route map as the second type argument when needed:

```typescript
import type { routes } from "./urls.gen.js";

type SP = RouteSearchParams<"search", routes>;
type P = RouteParams<"blogPost", routes>;
```

### Generated route types

In the generated `router.named-routes.gen.ts`, routes with search schemas
use `{ path, search }` objects:

```typescript
// router.named-routes.gen.ts (auto-generated)
export const NamedRoutes = {
  "search.index": { path: "/search", search: { q: "string", page: "number?", sort: "string?" } },
  "home.index": "/",  // No search schema -> plain string
} as const;
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

// In server component - type is inferred
import { useLoader } from "@rangojs/router";

async function ProductPage() {
  const product = await useLoader(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <h1>{product.name}</h1>;
}

// In client component - same type
"use client";
import { useLoaderData } from "@rangojs/router/client";

function ProductPrice() {
  const { product } = useLoaderData(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <span>${product.price}</span>;
}
```

## Handle Type Safety

Handles have typed data:

```typescript
// handles/breadcrumbs.ts
import { createHandle } from "@rangojs/router";

// All export patterns work: export const, const + export { X }, export { X as Y }
export const Breadcrumbs = createHandle<{ label: string; href: string }>();

// In route definition - use handle() DSL
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, handle }) => [
  path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
    handle(Breadcrumbs, { label: "Products", href: "/shop/products" }),
  ]),
]);

// In client - typed array
function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // crumbs: Array<{ label: string; href: string }>
}
```

## Ref Prop Type Safety (Loaders & Handles)

Loaders and handles can be passed as props from server to client components.
Use `typeof` to get the full typed definition without manually specifying generics:

```typescript
// loaders.ts
export const ProductLoader = createLoader(async (ctx) => {
  return { product: await fetchProduct(ctx.params.slug) };
});

// handles.ts
export const Breadcrumbs = createHandle<{ label: string; href: string }>();

// Client component — typeof infers all generics
"use client";
import { useLoader, useHandle } from "@rangojs/router/client";
import type { ProductLoader } from "../loaders";
import type { Breadcrumbs } from "../handles";

function MyComponent({
  loader,
  handle,
}: {
  loader: typeof ProductLoader;   // LoaderDefinition<{ product: Product }>
  handle: typeof Breadcrumbs;     // Handle<{ label: string; href: string }>
}) {
  const { data } = useLoader(loader);   // data is typed
  const crumbs = useHandle(handle);     // crumbs is typed array
  // ...
}
```

RSC Flight serialization calls `toJSON()` on both loaders and handles,
sending only `{ __brand, $$id }` to the client. The hooks recover the
full functionality from module-level registries.

## Location State Type Safety

```typescript
// location-states.ts
import { createLocationState } from "@rangojs/router";

// All export patterns work: export const, const + export { X }, export { X as Y }
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

## Multi-Project tsconfig Setup

For monorepos or multi-app setups, use a shared base tsconfig. Each app only needs
to extend the base and add its `router.tsx` to `files` so TypeScript picks up the
global type declarations (like `RSCRouter.Env`).

```jsonc
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

```jsonc
// apps/shop/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"]
}
```

```jsonc
// apps/blog/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"]
}
```

The `files` array ensures `router.tsx` (which contains `declare global { namespace RSCRouter { interface Env } }`)
is always included in the compilation even if nothing directly imports it. Route types come from the
auto-generated `*.named-routes.gen.ts` file (via `rango generate`), not from manual declaration.
Each app gets its own typed environment without interfering with other apps.

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

// 3. router.tsx - Create router and export reverse
const router = createRouter<AppEnv>({
  document: Document,
}).routes(urlpatterns);

// Optional: register environment type globally for implicit typing
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

export const reverse = router.reverse;
export default router;

// 4. Run `npx rango generate src/router.tsx` to generate
//    router.named-routes.gen.ts (auto-registers GeneratedRouteMap globally).
//    No manual RegisteredRoutes declaration needed.

// 5. loaders/*.ts - Type-safe loaders
export const ProductLoader = createLoader("product", async (ctx) => {
  // ctx.params: { slug: string }
  // ctx.env.Variables.user: User | undefined
  // ctx.env.Bindings.DB: D1Database
  return { product: await fetchProduct(ctx.params.slug) };
});

// 6. Server: ctx.reverse for named routes
path("/product/:slug", (ctx) => {
  return <Link to={ctx.reverse("shop")}>Back to Shop</Link>;
}, { name: "product" })

// 7. Client: useHref for mounted paths, href for absolute
"use client";
import { useHref, href, Link } from "@rangojs/router/client";
<Link to={href("/shop/product/widget")}>Widget</Link>
```
