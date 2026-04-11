---
name: migrate-react-router
description: Migrate a React Router v7/v6 project to @rangojs/router. Use when the user asks to "migrate from React Router", "convert React Router to Rango", "replace React Router", "move from Remix to Rango", or has a React Router / Remix app they want to port.
argument-hint: path-to-react-router-app
---

# Migrate from React Router to @rangojs/router

Covers React Router v7 (framework mode and library mode), v6, and Remix v2.

## Identify the mode first

React Router v7 has two modes that require different migration paths:

- **Framework mode** (`@react-router/dev` plugin, file-based routing, route module
  API with `loader`/`action`/`meta`/`headers`/`shouldRevalidate` exports) — this is
  the Remix successor. Migration involves replacing the route module convention with
  Rango's `urls()` DSL and server component handlers.

- **Library mode** (`createBrowserRouter` or `<BrowserRouter>`, client-side only) —
  migration involves moving from client-side routing to server-rendered RSC with the
  `urls()` DSL.

React Router v6 and Remix v2 follow the same patterns as v7 library mode and
framework mode respectively.

## Migration Strategy

Work route-by-route, bottom-up. Start with leaf routes, then layouts, then
loaders/actions. Verify each route works before moving to the next.

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
loader                      → fetch in handler, or createLoader()
action                      → "use server" function
meta                        → ctx.use(Meta) in handler
headers                     → ctx.header() in handler or middleware
shouldRevalidate            → revalidate() DSL
ErrorBoundary               → errorBoundary() DSL
HydrateFallback             → loading() DSL
handle                      → no equivalent needed (server components)
clientLoader / clientAction → "use client" component with useActionState
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

### RR7 file routing → urls() DSL

| RR7 file path | Rango |
|---|---|
| `app/routes/_index.tsx` | `path("/", HomePage, { name: "home" })` |
| `app/routes/about.tsx` | `path("/about", AboutPage, { name: "about" })` |
| `app/routes/blog.$slug.tsx` | `path("/blog/:slug", BlogPost, { name: "blogPost" })` |
| `app/routes/files.$.tsx` (splat) | `path("/files/:path+", FileBrowser, { name: "files" })` |
| `app/routes/dashboard.tsx` (layout) | `layout(<DashboardLayout />, () => [...])` |
| `app/routes/dashboard._index.tsx` | `path("/dashboard", DashboardIndex, { name: "dashboard" })` |
| `app/routes/dashboard.settings.tsx` | `path("/dashboard/settings", Settings, { name: "settings" })` |
| `app/routes/_auth.tsx` (pathless layout) | `layout(<AuthLayout />, () => [...])` |
| `app/routes/_auth.login.tsx` | `path("/login", LoginPage, { name: "login" })` |

### Library mode: config routes → urls() DSL

| React Router | Rango |
|---|---|
| `path: "/"` | `path("/", HomePage, { name: "home" })` |
| `path: "about"` | `path("/about", AboutPage, { name: "about" })` |
| `path: "blog/:slug"` | `path("/blog/:slug", BlogPost, { name: "blogPost" })` |
| `path: "files/*"` (splat) | `path("/files/:path+", FileBrowser, { name: "files" })` |
| `path: "docs?"` (optional segment) | `path("/docs/:slug*", Docs, { name: "docs" })` |

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

## 3. Data Fetching

### Loaders

React Router loaders run before rendering and provide data via `useLoaderData()`.
In Rango, server components can fetch data directly — no loader required:

```typescript
// React Router:
export async function loader({ params }) {
  const product = await getProduct(params.slug);
  return { product };
}
function ProductPage() {
  const { product } = useLoaderData();
  return <div>{product.name}</div>;
}

// Rango: fetch directly in the server component handler
const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  return <div>{product.name}</div>;
};
```

Use `createLoader()` when you need client-side data refresh, per-loader caching,
or revalidation control. See `/loader`.

### Actions

React Router form actions map to Rango server actions:

```typescript
// React Router:
export async function action({ request }) {
  const formData = await request.formData();
  await updateUser(formData.get("name"));
  return redirect("/profile");
}
function EditProfile() {
  return (
    <Form method="post">
      <input name="name" />
      <button type="submit">Save</button>
    </Form>
  );
}

// Rango: "use server" action + native form or useActionState
"use server";
import { redirect } from "@rangojs/router";

export async function updateProfile(formData: FormData): Promise<void> {
  await updateUser(formData.get("name") as string);
  throw redirect("/profile");
}

// Client component:
function EditProfile() {
  return (
    <form action={updateProfile}>
      <input name="name" />
      <button type="submit">Save</button>
    </form>
  );
}
```

Key difference: React Router actions are route-scoped (declared per route).
Rango actions are function-scoped (`"use server"` on any exported async function).

### useLoaderData / useActionData

There is no `useLoaderData()` in Rango. Server components fetch data directly.
For client components that need reactive data, use `createLoader()` + `useLoader()`:

```typescript
// React Router: useLoaderData() in component
function ProductPrice() {
  const { price } = useLoaderData();
  return <span>{price}</span>;
}

// Rango: useLoader() in client component
"use client";
import { useLoader } from "@rangojs/router/client";
import { PriceLoader } from "../loaders";

function ProductPrice() {
  const { data } = useLoader(PriceLoader);
  return <span>{data.price}</span>;
}
```

### clientLoader / clientAction (framework mode)

RR7 framework mode's `clientLoader` and `clientAction` run in the browser and
can call the server loader or skip it entirely. In Rango, the equivalent depends
on what the client loader/action does:

- **Client-side cache or transformation of server data** → use `createLoader()` +
  `useLoader()` in a client component. The loader runs on the server; the client
  component handles display logic.
- **Client-only data (localStorage, IndexedDB)** → keep as a `"use client"` component
  with `useState`/`useEffect`. No server involvement.
- **Optimistic UI** → use `useActionState` or `useOptimistic` with a `"use server"`
  action. Same React patterns, no framework-specific API.

### shouldRevalidate (framework mode)

RR7's `shouldRevalidate` export maps directly to Rango's `revalidate()` DSL:

```typescript
// RR7:
export function shouldRevalidate({ actionResult, currentParams, nextParams }) {
  if (actionResult) return true;
  return currentParams.slug !== nextParams.slug;
}

// Rango:
path("/product/:slug", ProductPage, { name: "product" }, () => [
  revalidate(({ actionId, currentParams, nextParams }) => {
    if (actionId) return true;
    return currentParams.slug !== nextParams.slug;
  }),
])
```

Note: RR7's `shouldRevalidate` controls client-side loader re-fetching. Rango's
`revalidate()` controls which segments re-run during partial rendering after
navigation or actions. The intent is the same — skip unnecessary work — but
the mechanism is segment-level rather than loader-level.

## 4. Middleware / Route Protection

React Router doesn't have built-in middleware. Protection is typically done in loaders:

```typescript
// React Router: auth check in loader
export async function loader({ request }) {
  const user = await getUser(request);
  if (!user) throw redirect("/login");
  return { user };
}

// Rango: router.use() for request-level auth
const router = createRouter({})
  .use(authInit)                        // all routes — resolves session
  .use("/dashboard/*", requireAuth)     // scoped guard
  .routes(urlpatterns);
```

Use `router.use()` for auth guards (wraps entire request including actions).
Use DSL `middleware()` for render-level concerns (context shaping, headers).
See `/middleware`.

## 5. Loading & Error States

### Loading / Suspense

```typescript
// React Router: defer() + Suspense, or HydrateFallback
export async function loader() {
  return defer({ data: fetchData() });
}

// Rango: loading() DSL for automatic Suspense boundaries
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  loading(<DashboardSkeleton />),
])
```

### Error boundaries

```typescript
// React Router:
{ path: "dashboard", element: <Dashboard />, errorElement: <ErrorPage /> }

// or with ErrorBoundary component:
function ErrorBoundary() {
  const error = useRouteError();
  return <div>Error: {error.message}</div>;
}

// Rango: errorBoundary() wrapping a group of routes
layout(<DashboardLayout />, () => [
  errorBoundary(({ error, reset }) => (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={reset}>Try again</button>
    </div>
  )),
  path("/dashboard", DashboardIndex, { name: "dashboard" }),
  path("/dashboard/settings", Settings, { name: "settings" }),
])
```

### Not found

```typescript
// React Router: { path: "*", element: <NotFound /> }

// Rango (app-level):
createRouter({
  notFound: ({ pathname }) => <NotFoundPage pathname={pathname} />,
})

// Rango (route-level — catches notFound() thrown in handlers/loaders):
layout(<ShopLayout />, () => [
  notFoundBoundary(<ProductNotFound />),
  path("/product/:slug", ProductPage, { name: "product" }),
])
```

## 6. Navigation

| React Router | Rango |
|---|---|
| `import { Link } from "react-router-dom"` | `import { Link } from "@rangojs/router/client"` |
| `<Link to="/about">` | `<Link to="/about">` |
| `useNavigate()` | `useRouter()` from `@rangojs/router/client` |
| `navigate("/about")` | `useRouter().push("/about")` |
| `navigate("/about", { replace: true })` | `useRouter().replace("/about")` |
| `navigate(-1)` | `useRouter().back()` |
| `useLocation().pathname` | `usePathname()` from `@rangojs/router/client` |
| `useSearchParams()` | `useSearchParams()` from `@rangojs/router/client` |
| `useParams()` | `ctx.params` in server handlers (no client hook needed) |
| `<NavLink>` | `<Link>` with `usePathname()` for active state |

### useNavigate → useRouter

```typescript
// React Router:
const navigate = useNavigate();
navigate("/dashboard");
navigate(-1);

// Rango:
const router = useRouter();
router.push("/dashboard");
router.back();
```

## 7. Metadata / Head

```typescript
// React Router: meta function export (framework mode)
export function meta() {
  return [{ title: "Home" }, { name: "description", content: "Welcome" }];
}

// Rango: Meta handle in server handlers
import { Meta } from "@rangojs/router";

const HomePage: Handler<"home"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Home" });
  meta({ name: "description", content: "Welcome" });
  return <div>Home page</div>;
};
```

Add `<MetaTags />` in the Document component's `<head>`:

```typescript
import { MetaTags } from "@rangojs/router/client";

function Document({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## 8. API / Resource Routes

```typescript
// React Router (framework mode):
// app/routes/api.users.ts
export async function loader() {
  return Response.json(await getUsers());
}

// Rango: response routes
path.json("/api/users", async () => {
  return await getUsers();
}, { name: "apiUsers" })
```

See `/response-routes` for `path.json()`, `path.text()`, `path.html()`, etc.

## 9. Key Conceptual Differences

| Concept | React Router | Rango |
|---|---|---|
| Rendering | Client-side by default, SSR opt-in | Server components by default (RSC) |
| Data loading | `loader()` + `useLoaderData()` | Direct fetch in server components |
| Form actions | Route-scoped `action()` | Function-scoped `"use server"` |
| Route definition | File-based or `createBrowserRouter` | `urls()` DSL with `path()`, `layout()` |
| Middleware | Not built-in (use loaders) | `router.use()` + DSL `middleware()` |
| Parallel routes | Not built-in | `parallel()` DSL |
| Intercepting routes | Not built-in | `intercept()` DSL |
| Caching | Not built-in | `cache()` DSL, `"use cache"` |
| Type-safe routes | Partial (v7 framework mode) | Full: params, names, href, reverse |

## Migration Checklist

1. [ ] Set up Vite config with `rango()` plugin
2. [ ] Create Document component with `<MetaTags />` in head
3. [ ] Create `router.tsx` with `createRouter()`
4. [ ] Convert route config / file routes to `urls()` DSL
5. [ ] Migrate layouts — keep `<Outlet />` (import from `@rangojs/router/client`)
6. [ ] Convert loaders to direct server component fetches (or `createLoader()` if needed)
7. [ ] Convert React Router actions to `"use server"` functions
8. [ ] Migrate auth guards from loaders to `router.use()`
9. [ ] Replace `react-router-dom` Link/navigation with `@rangojs/router/client`
10. [ ] Convert error boundaries to `errorBoundary()` DSL
11. [ ] Update metadata to use `Meta` handle + `<MetaTags />`
12. [ ] Run `npx rango generate src/` to generate route types
