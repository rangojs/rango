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
  const userId = ctx.get("user")?.id; // from Rango.Vars
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
});
```

## Global Environment Registration

Register environment types globally for implicit typing:

```typescript
// router.tsx
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
```

Now handlers have typed context without explicit imports:

```typescript
// In loaders
export const DashboardLoader = createLoader(async (ctx) => {
  // ctx.env.DB is typed from global Rango.Env
  // ctx.get("user") is typed from global Rango.Vars
  const user = ctx.get("user");
  return { user };
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

### Why not just use Rango.Vars?

`Rango.Vars` (via global namespace augmentation) provides app-global typing for
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
