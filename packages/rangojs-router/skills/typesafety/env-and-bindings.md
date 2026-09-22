# Environment, Context, and State Types

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

// Variables set by middleware — declared via global namespace augmentation
export interface AppVariables {
  user?: { id: string; email: string; role: string };
  requestId?: string;
  permissions?: string[];
}
```

### Using Environment Types

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import type { AppBindings, AppVariables } from "./env";

const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Register bindings and variables globally for implicit typing
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
```

```typescript
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
```

## Global Environment Registration

The `declare global` block above is what types the contexts. `createRouter<TEnv>()`
types the router instance, but `urls()` modules, `Handler`, middleware, and
response routes read `Rango.Env` / `Rango.Vars` — they cannot see the router's
generic. Put the block in a file that is part of every TypeScript program that
typechecks handlers (usually `router.tsx`, kept in via tsconfig `files`).

What each context sees:

| Context                               | `ctx.env`                                 | `ctx.get("key")`                       |
| ------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Handlers, middleware, response routes | `Rango.Env` (`unknown` if not registered) | `Rango.Vars` (`any` if not registered) |
| Loaders (`createLoader`)              | `any` (not typed from `Rango.Env`)        | `Rango.Vars` (`any` if not registered) |

An unregistered `Rango.Env` is deliberately `unknown`, so `ctx.env.DB` is a
compile error rather than a silent `any`. An unregistered `Rango.Vars` falls
back to `any` so string-key vars work with zero config.

```typescript
// In loaders
import { createLoader } from "@rangojs/router";

export const DashboardLoader = createLoader(async (ctx) => {
  const user = ctx.get("user"); // typed from global Rango.Vars
  const db = ctx.env.DB as D1Database; // ctx.env is `any` in loaders
  return { user, count: await countOrders(db, user?.id) };
});
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
interface SessionData {
  userId: string;
}
export const Session = createVar<SessionData>({ cache: false });
```

`createVar` accepts an optional options object. The `cache` option (default
`true`) controls whether the var's values can be read inside cache scopes.
Write-level escalation is also supported: `ctx.set(Var, value, { cache: false })`
marks a specific write as non-cacheable even if the var itself is cacheable.
"Least cacheable wins" — if either says `cache: false`, the value throws on
read inside `cache()` or `"use cache"`.

### Producer (handler, layout, or middleware)

Write with `ctx.set()` from middleware, route handlers, or layout handlers;
read with `ctx.get()` in the segments they wrap. A route handler runs before
the layouts and parallels declared in its own use callback (handler-first), so
those see the value; an outer layout wrapping the route renders first and
does not. See `/route` for the full ordering.

```typescript
import type { Handler } from "@rangojs/router";
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
import type { Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { Pagination } from "../vars/pagination.js";

// Mounted inside the producer's use callback:
// path("/articles", ArticleList, { name: "articles.list" }, () => [layout(PaginationLayout)])
export const PaginationLayout: Handler = (ctx) => {
  const pagination = ctx.get(Pagination); // typed as PaginationData | undefined
  return (
    <>
      <Outlet />
      {pagination && (
        <nav>
          Page {pagination.current} of {pagination.total}
        </nav>
      )}
    </>
  );
};
```

Type the layout (`Handler`) rather than annotating `ctx: any`: with `any`,
`ctx.get(Pagination)` is `any` too and the token contract is lost.

### Why not just use Rango.Vars?

`Rango.Vars` (via global namespace augmentation) provides app-global typing for
`ctx.get("key")` / `ctx.set("key", value)`. It works for middleware state
shared app-wide. `createVar<T>()` is for route-local or feature-scoped
context -- the producer and consumer import the same token, creating a
scoped contract without polluting global types.

Both approaches coexist: `ctx.get("user")` (global via Vars) and
`ctx.get(Pagination)` (scoped via createVar) work side by side.

## Handle Type Safety

A handle is typed by two parameters: `Handle<TData, TAccumulated>`. `TData` is
what each segment pushes; `TAccumulated` is what readers get after the collect
function runs (default `TData[][]`, one array per segment).

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
```

```tsx
// In client — typed array
"use client";
import { useHandle, Breadcrumbs } from "@rangojs/router/client";

function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs); // crumbs: BreadcrumbItem[]
  return (
    <nav>
      {crumbs.map((c) => (
        <a key={c.href} href={c.href}>
          {c.label}
        </a>
      ))}
    </nav>
  );
}
```

```typescript
// Custom handle: give TAccumulated whenever collect changes the shape
import { createHandle } from "@rangojs/router";

export const PageTitle = createHandle<string, string>(
  (segments) => segments.flat().at(-1) ?? "Default Title",
);
```

## Ref Prop Type Safety (Loaders & Handles)

Loaders and handles can be passed as props from server to client components.
Use `typeof` to get the full typed definition without manually specifying generics:

```typescript
// loaders.ts
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  return { product: await fetchProduct(ctx.params.slug) };
});

// Server: pass the definitions as props
path("/product/:slug", () => (
  <MyComponent loader={ProductLoader} handle={Breadcrumbs} />
), { name: "product" }, () => [loader(ProductLoader)]);
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
  handle: typeof Breadcrumbs; // Handle<BreadcrumbItem, BreadcrumbItem[]>
}) {
  const { data } = useLoader(loader); // data is typed
  const crumbs = useHandle(handle); // crumbs: BreadcrumbItem[]
  // ...
}
```

Loader and handle definitions are plain `{ __brand, $$id }` objects — the
loader function and the handle's collect function live in module-level
registries keyed by `$$id` — so they cross the RSC boundary as-is and the
hooks look the rest up by id. `useLoader()` still needs the loader registered
on the route with `loader()` (or use `useFetchLoader()` for on-demand fetching).

## Location State Type Safety

`createLocationState<T>()` returns a typed definition; the Vite plugin injects
its key, so it must be exported from a module. Values are stored in
`history.state`, so `T` must be structured-cloneable: functions, symbols,
class constructors, React elements, and `unknown` are compile errors.

```typescript
// location-states.ts
import { createLocationState } from "@rangojs/router";

// All export patterns work: export const, const + export { X }, export { X as Y }
export const ProductPreview = createLocationState<{
  name: string;
  price: number;
  image: string;
}>();

// Flash state: cleared after the first read
export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});
```

```tsx
"use client";
import { Link, href, useLocationState } from "@rangojs/router/client";
import { ProductPreview } from "./location-states";

// Passing state through Link
function ProductCard() {
  return (
    <Link
      to={href("/product/widget")}
      state={[ProductPreview({ name: "Widget", price: 99, image: "/img.jpg" })]}
    >
      View Product
    </Link>
  );
}

// Reading state in component
function ProductHeader() {
  const preview = useLocationState(ProductPreview);
  // preview: { name: string; price: number; image: string } | undefined

  if (preview) {
    return (
      <h1>
        {preview.name} - ${preview.price}
      </h1>
    );
  }
  return <h1>Loading...</h1>;
}
```

Other entry points: pass a getter (`ProductPreview(() => ({ ... }))`) to compute
the value at click time; `ctx.setLocationState(entry)` attaches state from a
handler; `redirect(url, { state })` carries it through a redirect; and
`ProductPreview.read()` / `.write(value)` / `.delete()` access the current
history entry outside React (client-only, non-reactive).
