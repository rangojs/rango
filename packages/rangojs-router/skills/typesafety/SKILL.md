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

const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Server-side named-route reverse (type-safe via routeMap)
export const reverse = router.reverse;

export default router;
```

### Which global type should I use?

Use the generated route map by default. Manual `RegisteredRoutes` augmentation
is only needed when you want the richer `typeof router.routeMap` shape
available globally.

- `GeneratedRouteMap` — auto-registered by `router.named-routes.gen.ts`
  Use for `Handler<"name">`, `Prerender<"name">`, server `ctx.reverse()`,
  and named-route param/search inference.
- `typeof router.routeMap` — the real merged route map from your router
  instance, including response-route metadata such as `{ path, response }`.
- `RegisteredRoutes` — manual global hook for exposing `typeof router.routeMap`
  to utilities like `href()`, `ValidPaths`, and `PathResponse`.

Recommended setup:

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";
import type { AppBindings, AppVars } from "./env";

export const router = createRouter<AppBindings>({}).routes(urlpatterns);

declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVars {}
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
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

In route handlers, `ctx.reverse()` uses two namespaces:

- **`.name`** — local route, resolved within the current `include()` scope
- **`name`** — global route, from the named-routes definition

```typescript
import type { Handler } from "@rangojs/router";

export const ProductHandler: Handler<"shop.product"> = (ctx) => {
  ctx.reverse(".cart"); // Local: /shop/cart
  ctx.reverse(".product", { slug: "widget" }); // Local: /shop/product/widget
  ctx.reverse("blog.post", { slug: "1" }); // Global: /blog/1
};
```

For type-safe local names, generate a route types file with `npx rango generate urls/shop.tsx`
and pass it as the second generic to `Handler` or `Prerender`:

```typescript
import type { Handler } from "@rangojs/router";
import type { routes } from "./shop.gen.js";

export const ProductHandler: Handler<"shop.product", routes> = (ctx) => {
  ctx.reverse(".cart"); // Type-safe local name
  ctx.reverse(".product", { slug: "widget" }); // Type-safe local with params
  ctx.reverse("blog.post", { slug: "hi" }); // Type-safe global name
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

`href()` and path-based response utilities read from `RegisteredRoutes`, so if
you want them typed globally you should augment:

```typescript
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

See `/links` for full URL generation guide.

## Environment Type Setup

Define your app's environment for type-safe bindings and variables:

```typescript
// env.ts

// Cloudflare bindings — passed as TEnv to createRouter<TEnv>()
export interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
  CACHE: KVNamespace;
  AI: Ai;
}

// Variables set by middleware — declared via module augmentation
export interface AppVariables {
  user?: { id: string; email: string; role: string };
  requestId?: string;
  permissions?: string[];
}
```

### Using Environment Types

```typescript
// router.tsx
import type { AppBindings, AppVariables } from "./env";

const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Register bindings and variables globally for implicit typing
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}

// middleware - typed via ctx.set / ctx.get
import type { Middleware } from "@rangojs/router";

export const authMiddleware: Middleware = async (ctx, next) => {
  ctx.set("user", {
    id: "123",
    email: "user@example.com",
    role: "admin",
  });
  await next();
};

// loaders - typed context
export const UserLoader = createLoader(async (ctx) => {
  const db = ctx.env.DB; // D1Database (plain bindings)
  const userId = ctx.get("user")?.id; // from RSCRouter.Vars
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
});
```

## Global Environment Registration

Register environment types globally for implicit typing:

```typescript
// router.tsx
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
```

Now handlers have typed context without explicit imports:

```typescript
// In loaders
export const DashboardLoader = createLoader(async (ctx) => {
  // ctx.env.DB is typed from global RSCRouter.Env
  // ctx.get("user") is typed from global RSCRouter.Vars
  const user = ctx.get("user");
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
});
```

### Handler with typed search params

`Handler<"name">` automatically resolves route params and search params from the
global `GeneratedRouteMap` (the gen file). No explicit route map import needed:

```typescript
// pages/search.tsx
import type { Handler } from "@rangojs/router";

export const SearchPage: Handler<"search"> = (ctx) => {
  // ctx.search is typed: { q: string; page?: number; sort?: string }
  const { q, page, sort } = ctx.search;
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
// { q: string | undefined; page?: number; sort?: string }

// RouteParams<"name"> resolves URL params from the route pattern
type P = RouteParams<"blogPost">;
// { slug: string }

// Optional URL params (`:slug?`) resolve to `string | undefined`
// because absent segments are omitted from `ctx.params` at runtime.
type C = RouteParams<"checkout">;
// { step?: string }
// → ctx.params.step is `string | undefined`; use `?? "default"` to coalesce.

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
  "search.index": {
    path: "/search",
    search: { q: "string", page: "number?", sort: "string?" },
  },
  "home.index": "/", // No search schema -> plain string
} as const;
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

// In server component - type is inferred
import { useLoader } from "@rangojs/router/client";

async function ProductPage() {
  const product = await useLoader(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <h1>{product.name}</h1>;
}

// In client component - same type
"use client";
import { useLoader } from "@rangojs/router/client";

function ProductPrice() {
  const { data } = useLoader(ProductLoader);
  // data: { id: string; name: string; price: number }
  const product = data;
  return <span>${product.price}</span>;
}
```

## Typed Context Variables

`createVar<T>()` creates a typed token for `ctx.set()`/`ctx.get()`, making
handler-to-layout data contracts explicit and compile-time verified:

```typescript
import { createVar } from "@rangojs/router";

// Define a typed token (shared between producer and consumer)
interface PaginationData {
  current: number;
  total: number;
  perPage: number;
}
export const Pagination = createVar<PaginationData>();

// Non-cacheable var — reading inside cache() or "use cache" throws at runtime
const Session = createVar<SessionData>({ cache: false });
```

`createVar` accepts an optional options object. The `cache` option (default
`true`) controls whether the var's values can be read inside cache scopes.
Write-level escalation is also supported: `ctx.set(Var, value, { cache: false })`
marks a specific write as non-cacheable even if the var itself is cacheable.
"Least cacheable wins" — if either says `cache: false`, the value throws on
read inside `cache()` or `"use cache"`.

### Producer (handler or middleware)

```typescript
import { Pagination } from "../vars/pagination.js";

const ArticleList: Handler<"articles.list"> = async (ctx) => {
  ctx.set(Pagination, {       // type-checked
    current: 1,
    total: 10,
    perPage: 5,
  });
  return <Articles />;
};
```

### Consumer (layout, parallel, or any context with get)

```typescript
import { Pagination } from "../vars/pagination.js";

export function PaginationLayout(ctx: any) {
  const pagination = ctx.get(Pagination);  // typed as PaginationData | undefined
  if (!pagination) return <Outlet />;
  return <nav>Page {pagination.current} of {pagination.total}</nav>;
}
```

### Why not just use RSCRouter.Vars?

`RSCRouter.Vars` (via module augmentation) provides app-global typing for
`ctx.get("key")` / `ctx.set("key", value)`. It works for middleware state
shared app-wide. `createVar<T>()` is for route-local or feature-scoped
context -- the producer and consumer import the same token, creating a
scoped contract without polluting global types.

Both approaches coexist: `ctx.get("user")` (global via Vars) and
`ctx.get(Pagination)` (scoped via createVar) work side by side.

## Handle Type Safety

Handles have typed data:

```typescript
// Built-in Breadcrumbs handle — import from "@rangojs/router"
import { Breadcrumbs } from "@rangojs/router";
// Type: Handle<BreadcrumbItem, BreadcrumbItem[]>
// BreadcrumbItem: { label: string; href: string; content?: ReactNode | Promise<ReactNode> }

// In route handler — push is fully typed
path("/shop/product/:slug", (ctx) => {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Products", href: "/shop/products" });
  return <ProductPage />;
}, { name: "product" });

// In client — typed array
import { useHandle, Breadcrumbs } from "@rangojs/router/client";
function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // crumbs: BreadcrumbItem[]
}

// Custom handles also work the same way
import { createHandle } from "@rangojs/router";
export const PageTitle = createHandle<string, string>(
  (segments) => segments.flat().at(-1) ?? "Default Title"
);
```

## Ref Prop Type Safety (Loaders & Handles)

Loaders and handles can be passed as props from server to client components.
Use `typeof` to get the full typed definition without manually specifying generics:

```typescript
// loaders.ts
export const ProductLoader = createLoader(async (ctx) => {
  return { product: await fetchProduct(ctx.params.slug) };
});

// Built-in Breadcrumbs — or any custom handle created with createHandle()
```

```tsx
// Client component — typeof infers all generics
"use client";
import { useLoader, useHandle, type Breadcrumbs } from "@rangojs/router/client";
import type { ProductLoader } from "../loaders";

function MyComponent({
  loader,
  handle,
}: {
  loader: typeof ProductLoader; // LoaderDefinition<{ product: Product }>
  handle: typeof Breadcrumbs; // Handle<{ label: string; href: string }>
}) {
  const { data } = useLoader(loader); // data is typed
  const crumbs = useHandle(handle); // crumbs is typed array
  // ...
}
```

RSC Flight serialization calls `toJSON()` on both loaders and handles,
sending only `{ __brand, $$id }` to the client. The hooks recover the
full functionality from module-level registries.

## Stable identity: `path#export`

Loaders, handles, cached functions (`functionId`), and server actions
(`actionId`) all share one identity scheme: `{modulePath}#{exportName}`,
injected at build by the `exposeInternalIds` and `exposeActionId` Vite plugins.
This is also the identity React server actions carry across the Flight boundary,
which is why a `revalidate()` predicate sees an action as a `path#export` string:

```typescript
revalidate(
  ({ actionId }) => actionId === "src/actions/cart.ts#addToCart" || undefined,
);
```

`actionId` is the only stable reference React exposes across the Flight boundary,
so it stays as the floor and escape hatch. The hand-written-string surface
(`actionId?.includes("cart.ts#")`) is brittle: a renamed action or moved file
silently stops matching with no compile error. A typed helper that resolves this
id from an imported action reference — making a rename a type error in one place
— is **planned**, not yet shipped. Until it lands, keep the substring match in a
single named revalidation contract (`/composability`) so a rename only has to be
fixed in one place.

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
    "resolveJsonModule": true,
  },
}
```

```jsonc
// apps/shop/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"],
}
```

```jsonc
// apps/blog/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"],
}
```

The `files` array ensures `router.tsx` (which contains `declare global { namespace RSCRouter { interface Env; interface Vars } }`)
is always included in the compilation even if nothing directly imports it. Route types come from the
auto-generated `*.named-routes.gen.ts` file (via `rango generate`), not from manual declaration.
Each app gets its own typed environment without interfering with other apps.

## Complete Type-Safe Setup

```typescript
// 1. env.ts - Environment types
export interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
}

export interface AppVariables {
  user?: { id: string; email: string; role: string };
}

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
const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Register bindings and variables globally for implicit typing
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}

export const reverse = router.reverse;
export default router;

// 4. Run `npx rango generate src/router.tsx` to generate
//    router.named-routes.gen.ts (auto-registers GeneratedRouteMap globally).
//    No manual RegisteredRoutes declaration needed.

// 5. loaders/*.ts - Type-safe loaders
export const ProductLoader = createLoader(async (ctx) => {
  // ctx.params: { slug: string }
  // ctx.get("user"): User | undefined  (from RSCRouter.Vars)
  // ctx.env.DB: D1Database  (plain bindings from RSCRouter.Env)
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
