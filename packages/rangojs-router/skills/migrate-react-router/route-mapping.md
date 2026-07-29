# Project Setup and Route Mapping

## 1. Project Setup

Replace React Router tooling with Vite + Rango:

```bash
# Framework mode:
npm remove react-router @react-router/dev @react-router/node @react-router/serve
# Library mode:
npm remove react-router react-router-dom

npm install @rangojs/router
```

Replace the `@react-router/dev` Vite plugin with `rango()`:

```typescript
// vite.config.ts
// Before: import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [rango()],
});
```

Delete `react-router.config.ts` — route configuration moves to the `urls()` DSL.

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

export default createRouter({
  document: Document,
}).routes(urlpatterns);
```

## 2. Route Mapping

### RR7 framework mode: route modules → urls() DSL

In framework mode, each route is a file with conventional exports (`loader`,
`action`, `default`, `meta`, `headers`, `shouldRevalidate`, `handle`,
`ErrorBoundary`, `HydrateFallback`). In Rango, all of these become part of the
`urls()` DSL or move into the server component handler:

```text
RR7 route module export     → Rango equivalent
─────────────────────────────────────────────────────
default (Component)         → handler in path()
loader                      → fetch in handler, or createLoader() — a Rango
                              loader keeps the RR shape: throw redirect()/
                              notFound(), push meta from the body
action                      → "use server" function
meta                        → ctx.use(Meta) in handler; meta({ data }) →
                              ctx.use(Meta) push in the loader that owns data
headers                     → ctx.header() in handler or middleware
shouldRevalidate            → revalidate() DSL
ErrorBoundary               → errorBoundary() DSL
HydrateFallback             → loading() DSL
handle                      → createHandle() for cross-segment data (breadcrumbs, etc.)
clientLoader / clientAction → "use client" component with React hooks
```

#### Example: full route module migration

```typescript
// RR7 framework mode: app/routes/product.$slug.tsx
import type { Route } from "./+types/product.$slug";

export async function loader({ params }: Route.LoaderArgs) {
  const product = await getProduct(params.slug);
  if (!product) throw new Response("Not Found", { status: 404 });
  return { product };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  await addToCart(formData.get("productId") as string);
  return { ok: true };
}

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data.product.name }];
}

export function headers() {
  return { "Cache-Control": "max-age=300" };
}

export function shouldRevalidate({ actionResult }) {
  return !!actionResult;
}

export default function ProductPage({ loaderData }: Route.ComponentProps) {
  return <div>{loaderData.product.name}</div>;
}

export function ErrorBoundary() {
  return <div>Product error</div>;
}
```

```typescript
// Rango: urls.tsx + handler
import { notFound } from "@rangojs/router";

const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  if (!product) notFound("Product not found");

  const meta = ctx.use(Meta);
  meta({ title: product.name });
  ctx.header("Cache-Control", "max-age=300");

  return <div>{product.name}</div>;
};

// In urls.tsx:
path("/product/:slug", ProductPage, { name: "product" }, () => [
  revalidate(({ actionId }) => !!actionId),
  errorBoundary(() => <div>Product error</div>),
  loading(<ProductSkeleton />),
])
```

Key shift: the route module's scattered exports consolidate into the handler
(data fetching, meta, headers) and the DSL (revalidation, error boundary, loading).

The loader-shaped variant is equally valid — and closer to the RR module when
the loader carried authority. A `createLoader()` body can throw `notFound()`
for the missing product AND push the data-derived meta itself
(`ctx.use(Meta)({ title: product.name })`); register it with
`loader(ProductLoader, { ssr: false })` when the 404 status and
title must be in the document deterministically. See `/loader` → "Loader
Authority" and "Writing Handles from Loaders". (One RR habit that does NOT
carry over: a loader `throw redirect()` is a client-side navigate on document
loads, never an HTTP 302 — pre-stream 302s belong in middleware.)

### RR7 file routing → urls() DSL

| RR7 file path                            | Rango                                                         |
| ---------------------------------------- | ------------------------------------------------------------- |
| `app/routes/_index.tsx`                  | `path("/", HomePage, { name: "home" })`                       |
| `app/routes/about.tsx`                   | `path("/about", AboutPage, { name: "about" })`                |
| `app/routes/blog.$slug.tsx`              | `path("/blog/:slug", BlogPost, { name: "blogPost" })`         |
| `app/routes/files.$.tsx` (splat)         | `path("/files/:path*", FileBrowser, { name: "files" })`       |
| `app/routes/dashboard.tsx` (layout)      | `layout(<DashboardLayout />, () => [...])`                    |
| `app/routes/dashboard._index.tsx`        | `path("/dashboard", DashboardIndex, { name: "dashboard" })`   |
| `app/routes/dashboard.settings.tsx`      | `path("/dashboard/settings", Settings, { name: "settings" })` |
| `app/routes/_auth.tsx` (pathless layout) | `layout(<AuthLayout />, () => [...])`                         |
| `app/routes/_auth.login.tsx`             | `path("/login", LoginPage, { name: "login" })`                |

### Library mode: config routes → urls() DSL

| React Router                           | Rango                                                   |
| -------------------------------------- | ------------------------------------------------------- |
| `path: "/"`                            | `path("/", HomePage, { name: "home" })`                 |
| `path: "about"`                        | `path("/about", AboutPage, { name: "about" })`          |
| `path: "blog/:slug"`                   | `path("/blog/:slug", BlogPost, { name: "blogPost" })`   |
| `path: "files/*"` (splat)              | `path("/files/:path*", FileBrowser, { name: "files" })` |
| `path: "docs/:lang?"` (optional param) | `path("/docs/:lang?", Docs, { name: "docs" })`          |

The RR splat (`$` / `*`) matches the bare parent too (`/files` binds `""`), so
it maps to `:path*` (zero-or-more). Use `:path+` only when you require at least
one trailing segment. RR reads the splat at `params["*"]`; Rango exposes it as a
named string at `ctx.params.path` with the `/` separators preserved (split to
recover RR's array):

```typescript
path("/files/:path*", (ctx) => {
  const parts = ctx.params.path === "" ? [] : ctx.params.path.split("/");
  return <FileBrowser path={parts} />;
}, { name: "files" });
```

### Layouts

React Router layouts use `<Outlet />` — same concept in Rango:

```typescript
// React Router:
function DashboardLayout() {
  return (
    <div className="dashboard">
      <Outlet />
    </div>
  );
}

// route config:
{ path: "dashboard", element: <DashboardLayout />, children: [...] }

// Rango: same <Outlet />, from @rangojs/router/client
import { Outlet } from "@rangojs/router/client";

layout(<DashboardLayout />, () => [
  path("/dashboard", DashboardIndex, { name: "dashboard" }),
  path("/dashboard/settings", Settings, { name: "settings" }),
])
```

### Dynamic layouts (with data)

```typescript
// React Router: useLoaderData() in layout component
function DashboardLayout() {
  const { user } = useLoaderData();
  return <Shell user={user}><Outlet /></Shell>;
}

// Rango: handler function layout (server component)
layout(async (ctx) => {
  const user = ctx.get("user");
  return (
    <Shell user={user}>
      <Outlet />
    </Shell>
  );
}, () => [
  path("/dashboard", DashboardIndex, { name: "dashboard" }),
])
```

### Nested routes

React Router's nested route tree maps directly to Rango's `layout()` nesting:

```typescript
// React Router:
createBrowserRouter([{
  path: "/",
  element: <RootLayout />,
  children: [
    { path: "dashboard",
      element: <DashboardLayout />,
      children: [
        { index: true, element: <DashboardIndex /> },
        { path: "settings", element: <Settings /> },
      ]
    },
  ]
}])

// Rango:
urls(({ path, layout }) => [
  layout(<RootLayout />, () => [
    layout(<DashboardLayout />, () => [
      path("/dashboard", DashboardIndex, { name: "dashboard" }),
      path("/dashboard/settings", Settings, { name: "settings" }),
    ]),
  ]),
])
```

### Route groups / pathless layouts

React Router's pathless routes (layout routes without a path) are Rango's
layouts without a URL prefix:

```typescript
// React Router: { element: <AuthLayout />, children: [...] }

// Rango: layout with no URL segment
layout(<AuthLayout />, () => [
  path("/login", LoginPage, { name: "login" }),
  path("/register", RegisterPage, { name: "register" }),
])
```

### Index routes

```typescript
// React Router: { index: true, element: <Home /> }

// Rango: path with "/" inside a layout
layout(<RootLayout />, () => [
  path("/", HomePage, { name: "home" }),
])
```
