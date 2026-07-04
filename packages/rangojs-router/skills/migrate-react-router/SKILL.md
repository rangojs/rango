---
name: migrate-react-router
description: Migrate a React Router v7/v6 project to @rangojs/router. Use when the user asks to "migrate from React Router", "convert React Router to Rango", "replace React Router", "move from Remix to Rango", or has a React Router / Remix app they want to port.
argument-hint: path-to-react-router-app
---

# Migrate from React Router to @rangojs/router

Covers React Router v7 (framework mode and library mode), v6, and Remix v2.

## Why Rango

Common reasons to migrate:

- **Server components by default** — move from client-first route rendering to
  server-first UI and data fetching.
  See: `/router-setup`, `/route`
- **Django-style route definition** — `urls()`, `path()`, and `layout()` make
  the route tree explicit instead of splitting behavior across route modules or
  router config objects.
  See: `/route`, `/layout`
- **Named routes** — reverse URLs by route name instead of repeating path
  strings in links, redirects, and navigation logic.
  See: `/links`, `/typesafety`
- **Clear execution model** — request scope, render scope, segment boundaries,
  and shared `ctx` behavior are explicit instead of being inferred from route
  module conventions.
  See: `/middleware`, `/loader`
- **Live data layer** — `createLoader()` and `loader()` keep data fresh
  independently of cached UI. A route can serve cached segments while loaders
  still resolve live on every request.
  See: `/loader`, `/caching`, `/cache-guide`
- **Explicit caching model** — `cache()` DSL, `revalidate()`, `use cache`, and
  custom cache stores make data and render caching a first-class part of the router.
  See: `/caching`, `/cache-guide`, `/use-cache`
- **Build-time rendering** — `Static()` and `Prerender()` provide explicit
  build-time rendering for routes that benefit from it.
  See: `/prerender`
- **Composable route tree** — layouts, includes, middleware, parallels, and
  intercepts compose directly in the route definition.
  See: `/composability`, `/parallel`, `/intercept`
- **Multi-router flexibility** — support multiple routers, domain routing, and
  more advanced host-routing setups than a single client router tree.
  See: `/host-router`

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

## Replace imports, never shim React Router

Do NOT create mock `react-router` modules, Vite aliases, or compatibility
wrappers (a local `useLoaderData` backed by context, a `Form` that wraps
`<form>`, a fake `useFetcher`). Shims freeze RR semantics into the app, hide
unsupported behavior until runtime, and keep the old packages in the dependency
graph. Replace every `react-router` / `react-router-dom` / `@remix-run/*`
import at its call site:

| React Router import                           | Replace with                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Link`, `NavLink`                             | `Link` from `@rangojs/router/client` (`NavLink` active state via `usePathname()`, see §6) |
| `Outlet`                                      | `Outlet` from `@rangojs/router/client`                                                    |
| `useNavigate`                                 | `useRouter()` from `@rangojs/router/client` (see §6)                                      |
| `useLocation`, `useSearchParams`, `useParams` | `usePathname()`, `useSearchParams()`, `useParams()` from `@rangojs/router/client`         |
| `useLoaderData`                               | merge the loader into the handler; `useLoader()` only for live client data (see §3)       |
| `useActionData`                               | `useActionState` (standard React, see §3)                                                 |
| `Form`                                        | `<form action={serverAction}>` with a `"use server"` function (see §3)                    |
| `useFetcher`                                  | submits → server actions + `useActionState`/`useOptimistic`; reads → `useLoader()`        |
| `defer` / `Await`                             | `loading()` DSL / plain `<Suspense>` (see §5)                                             |
| `json()`, `redirect()`                        | plain return values; `redirect` from `@rangojs/router`                                    |
| `useRouteError`                               | the `error` prop of `errorBoundary()` (see §5)                                            |

If an import has no row here and no obvious Rango equivalent, stop and surface
it to the user — do not mock it to keep the build green.

Done means: `grep -rnE "from ['\"](react-router|@remix-run)" src/ app/` returns
nothing, and the packages are out of `package.json`.

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

## 3. Data Fetching

### Loaders → handler (the default migration)

In React Router, loaders and components are separate: the loader fetches data,
the component renders it via `useLoaderData()`. In Rango, server component
handlers do both — combine the loader and component into a single handler:

```typescript
// React Router: separate loader + component
export async function loader({ params }) {
  const product = await getProduct(params.slug);
  return { product };
}
function ProductPage() {
  const { product } = useLoaderData();
  return <div>{product.name}</div>;
}

// Rango: handler fetches and renders directly
const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  return <div>{product.name}</div>;
};
```

This is the standard migration path. The handler IS the loader — it fetches
data, then returns JSX. No separate data-fetching layer needed.

### When to use createLoader()

Rango's `createLoader()` is a live data layer, not a loader migration target.
Use it only when you need capabilities beyond what the handler provides:

- **Client-side reactive data** — `useLoader()` in client components for data
  that updates without a full page navigation
- **Shared data across segments** — a loader registered on a layout is available
  to all child routes via `ctx.use(Loader)` or `useLoader(Loader)`
- **Independent revalidation** — `revalidate()` on a specific loader after actions
- **Per-loader caching** — `loader(L, () => [cache({ ttl: 60 })])`

If the React Router loader just fetches data for its page component, merge it
into the handler. See `/loader` for when the live data layer is useful.

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

### useLoaderData

There is no `useLoaderData()` in Rango. For most cases, the handler fetches
and renders directly (see above). When a client component needs live reactive
data, use `createLoader()` + `useLoader()`:

```typescript
// React Router: useLoaderData() in client component
function ProductPrice() {
  const { price } = useLoaderData();
  return <span>{price}</span>;
}

// Rango: useLoader() reads from a registered loader (live data layer)
"use client";
import { useLoader } from "@rangojs/router/client";
import { PriceLoader } from "../loaders";

function ProductPrice() {
  const { data } = useLoader(PriceLoader);
  return <span>{data.price}</span>;
}
```

`useLoader()` provides live data that stays fresh — it re-fetches on navigation
and after actions (controlled by `revalidate()`). This is different from
`useLoaderData()` which just reads a snapshot.

### useActionData

React Router's `useActionData()` reads the return value of a route-scoped
`action()`. In Rango, actions are standard React server actions (`"use server"`),
so all React patterns apply directly:

```typescript
// React Router:
export async function action({ request }) {
  const form = await request.formData();
  const errors = validate(form);
  if (errors) return { errors };
  await save(form);
  return { ok: true };
}
function EditForm() {
  const data = useActionData();
  return (
    <Form method="post">
      {data?.errors && <p>{data.errors}</p>}
      <input name="title" />
      <button>Save</button>
    </Form>
  );
}

// Rango: useActionState (standard React hook)
"use client";
import { useActionState } from "react";
import { saveForm } from "../actions"; // "use server" function

function EditForm() {
  const [state, action, pending] = useActionState(saveForm, null);
  return (
    <form action={action}>
      {state?.errors && <p>{state.errors}</p>}
      <input name="title" />
      <button disabled={pending}>Save</button>
    </form>
  );
}
```

Since Rango uses RSC server actions, all React action patterns work:
`useActionState`, `useOptimistic`, `useTransition`, `startTransition`,
and plain `<form action={serverAction}>`. No framework-specific hook needed.

For the full guide — defining actions, validation with Zod, error handling,
revalidation rules, file uploads, and progressive enhancement — see
`/server-actions`.

### clientLoader / clientAction (framework mode)

RR7 framework mode's `clientLoader` and `clientAction` run in the browser.
Rango does not have a framework-level client loader/action concept — these
migrate to standard React client-side code:

```typescript
// RR7: clientLoader fetching from a third-party API
export async function clientLoader() {
  const res = await fetch("https://api.weather.com/current?city=london");
  return res.json();
}

// Rango: "use client" component with hooks
"use client";
import { useState, useEffect } from "react";

function WeatherWidget() {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    fetch("https://api.weather.com/current?city=london")
      .then((r) => r.json())
      .then(setWeather);
  }, []);
  if (!weather) return <span>Loading...</span>;
  return <span>{weather.temp}°C</span>;
}
```

The general rule: anything that ran in `clientLoader`/`clientAction` moves into
React hooks (`useState`, `useEffect`, `useActionState`, `useOptimistic`) inside
a `"use client"` component. There is no framework wrapper — it's just React.

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
]);
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
  .use(authInit) // all routes — resolves session
  .use("/dashboard/*", requireAuth) // scoped guard
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
// Server-side error boundaries only receive `error` (no `reset` — server render
// cannot be retried; users can navigate away or refresh).
layout(<DashboardLayout />, () => [
  errorBoundary(({ error }) => (
    <div>
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
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

| React Router                              | Rango                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `import { Link } from "react-router-dom"` | `import { Link } from "@rangojs/router/client"`                                  |
| `<Link to="/about">`                      | `<Link to="/about">`                                                             |
| `useNavigate()`                           | `useRouter()` from `@rangojs/router/client`                                      |
| `navigate("/about")`                      | `useRouter().push("/about")`                                                     |
| `navigate("/about", { replace: true })`   | `useRouter().replace("/about")`                                                  |
| `navigate(-1)`                            | `useRouter().back()`                                                             |
| `useLocation().pathname`                  | `usePathname()` from `@rangojs/router/client`                                    |
| `useSearchParams()`                       | `useSearchParams()` from `@rangojs/router/client`                                |
| `useParams()`                             | `useParams()` from `@rangojs/router/client` (or `ctx.params` in server handlers) |
| `useParams<T>()`                          | `useParams<T>()` — same generic annotation pattern                               |
| `<NavLink>`                               | `<Link>` with `usePathname()` for active state                                   |

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
path.json(
  "/api/users",
  async () => {
    return await getUsers();
  },
  { name: "apiUsers" },
);
```

See `/response-routes` for `path.json()`, `path.text()`, `path.html()`, etc.

## 9. Theme / Dark Mode

Rango has a built-in theme system with FOUC prevention. If the React Router app
uses a custom theme provider or `next-themes`, replace it with Rango's theme API:

```typescript
const router = createRouter({
  theme: true, // or { defaultTheme: "system", attribute: "class" }
});
```

Client components use `useTheme()` to read and toggle:

```typescript
"use client";
import { useTheme } from "@rangojs/router/theme";

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme}</button>;
}
```

See `/theme` for full API including system detection and cookie persistence.

## 10. Cloudflare Workers: streaming, dev tooling, and deploy

This is the part of an RR7-on-Cloudflare migration that the API tables above do
**not** cover, and it produces symptoms that look like router bugs but aren't.
RR7 serves a fully-rendered HTML/Turbo-Stream response; Rango serves a **streamed**
RSC/SSR response. Anything in the request path that was harmless for RR7 but
**buffers the response** silently kills that stream — the `loading()` /
`<Suspense>` fallback never shows and the page appears "awaited" (old content
held until everything resolves).

### 10a. Never buffer the Rango response in a custom worker entry

RR7 Cloudflare entries commonly **rewrite the response body** — `await
response.text()` / `await response.arrayBuffer()`, `HTMLRewriter`, cookie/URL
rewriting, hybrid-proxy bridging. That is fine for RR7's complete HTML, but if it
runs on the **Rango** path it consumes the stream and you lose streaming
entirely.

Rule: in the worker entry, the Rango response must pass through as a **stream**.
Buffer only on non-Rango branches (a legacy/SFRA proxy, an error page).

```typescript
// BAD — buffers the whole RSC stream before returning (no streaming, no fallback)
const response = await router.fetch(request, { env, ctx });
const body = await response.text(); // <- drains the stream
return new Response(rewrite(body), response);

// GOOD — pass the body through as a stream (re-wrap headers only)
const response = await router.fetch(request, { env, ctx });
return new Response(response.body, response); // <- streams; safe to add headers
```

If you keep a legacy proxy (e.g. an SFRA/host fallback) that legitimately buffers
to rewrite HTML, gate it so it only runs for proxied paths — never for the
`router.fetch()` result.

Keep the custom entry itself (host/site resolution, sessions, proxy fallback) —
that's real product logic, not a deviation. Just don't let it touch the stream.

### 10b. Use `vite dev` / `vite preview`, not `wrangler dev`, for local work

The `@cloudflare/vite-plugin` runs **your worker entry** inside miniflare for both
`vite dev` and `vite preview`, with bindings + `.dev.vars`, and it **streams**.
`wrangler dev` does **not** stream RSC locally: it gzip-compresses the response by
buffering the entire body before sending. Measured on a bare streaming Worker
under `wrangler dev`: `Accept-Encoding: gzip` → first byte at the full delay
(buffered); `Accept-Encoding: identity` → first byte at ~3ms (streams). The
deployed Cloudflare edge does **streaming** compression, so this is a
**local-`wrangler dev`-only artifact** — do not mistake it for a production
streaming bug (verify the deployed edge with `curl` and watch chunk timing /
`transfer-encoding: chunked`).

```jsonc
// package.json — the standard rango-on-Workers shape
"dev":     "vite",          // streams, bindings, .dev.vars live
"build":   "vite build",
"preview": "vite preview",  // runs the built worker in workerd; also streams
// wrangler is only for: wrangler deploy / wrangler secret
```

If a workflow truly requires `wrangler dev`, declare `Content-Encoding: identity`
on streamed responses, gated to local hostnames (so the edge still compresses):

```typescript
if (
  isLocalHostname(url.hostname) &&
  response.body &&
  !response.headers.has("content-encoding")
) {
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("text/x-component")) {
    const headers = new Headers(response.headers);
    headers.set("content-encoding", "identity"); // wrangler skips gzip -> streams
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
```

### 10c. `.dev.vars` loads differently per tool

A frequent "my env vars vanished after migration" symptom — it's the tool, not
the file:

| Command        | How `.dev.vars` is loaded                                                            |
| -------------- | ------------------------------------------------------------------------------------ |
| `wrangler dev` | Loaded natively at runtime (RR7's path — why it "worked before")                     |
| `vite dev`     | Loaded **live** by the plugin (+ `.dev.vars.<CLOUDFLARE_ENV>` if a named env is set) |
| `vite preview` | Read from the **build output** `dist/<env>/.dev.vars`, written at `vite build` time  |

So `vite preview` only sees vars that were present when you built — re-run
`vite build` after editing `.dev.vars`. (`vite dev` is the simplest: live vars +
streaming, no rebuild.)

### 10d. Build output moves from `build/` to `dist/`

RR7's `react-router build` writes to `build/`; Rango's `vite build` writes to
`dist/` (`dist/client`, `dist/rsc`, …). The leftover `build/` paths in
`wrangler.toml` and cleanup scripts must move, or you deploy stale/empty assets:

```toml
# wrangler.toml — was RR7's react-router build output
- assets = { directory = "./build/client/", binding = "ASSETS" }
+ assets = { directory = "./dist/client/",  binding = "ASSETS" }
```

```jsonc
// package.json — clean the real output dir
- "cleanup": "rimraf ./build ./public/build"
+ "cleanup": "rimraf ./dist ./build ./public/build"
```

### 10e. Deploy the built worker, not the source entry

`vite build` emits the **deployable** Worker config at `dist/<env>/wrangler.json`
with `main: "index.js"` (the bundled worker), `no_bundle: true`, and
`assets: "../client"`. A plain `wrangler deploy` run from the repo root uses the
**root** `wrangler.toml`, where `main` points at your **source** entry
(`app/.../worker.ts`) — and wrangler's bundler cannot resolve Rango's
`virtual:rsc-router/*` modules, so deploying the source entry fails or ships a
broken worker. Deploy the build output instead (e.g.
`wrangler deploy -c dist/<env>/wrangler.json`) or use the plugin's deploy flow.
RR7's `wrangler deploy` from root worked only because its worker was already
fully bundled by `react-router build`.

## 11. Key Conceptual Differences

| Concept             | React Router                        | Rango                                  |
| ------------------- | ----------------------------------- | -------------------------------------- |
| Rendering           | Client-side by default, SSR opt-in  | Server components by default (RSC)     |
| Data loading        | `loader()` + `useLoaderData()`      | Direct fetch in server components      |
| Form actions        | Route-scoped `action()`             | Function-scoped `"use server"`         |
| Route definition    | File-based or `createBrowserRouter` | `urls()` DSL with `path()`, `layout()` |
| Middleware          | Not built-in (use loaders)          | `router.use()` + DSL `middleware()`    |
| Parallel routes     | Not built-in                        | `parallel()` DSL                       |
| Intercepting routes | Not built-in                        | `intercept()` DSL                      |
| Caching             | Not built-in                        | `cache()` DSL, `"use cache"`           |
| Type-safe routes    | Partial (v7 framework mode)         | Full: params, names, href, reverse     |

## Migration Checklist

1. [ ] Set up Vite config with `rango()` plugin
2. [ ] Create Document component with `<MetaTags />` in head
3. [ ] Create `router.tsx` with `createRouter()`
4. [ ] Convert route config / file routes to `urls()` DSL
5. [ ] Migrate layouts — keep `<Outlet />` (import from `@rangojs/router/client`)
6. [ ] Merge loaders + components into handler functions (fetch + render in one place)
7. [ ] Convert React Router actions to `"use server"` functions
8. [ ] Migrate auth guards from loaders to `router.use()`
9. [ ] Replace `react-router-dom` Link/navigation with `@rangojs/router/client`
10. [ ] Convert error boundaries to `errorBoundary()` DSL
11. [ ] Update metadata to use `Meta` handle + `<MetaTags />`
12. [ ] Replace custom theme provider with `theme: true` in createRouter (see `/theme`)
13. [ ] Run `npx rango generate src/` to generate route types
14. [ ] Verify no shims: `grep -rnE "from ['\"](react-router|@remix-run)" src/ app/`
        returns nothing, no mock modules or aliases exist, and the packages are
        out of `package.json`

**Cloudflare Workers (if migrating an RR7-on-Workers app):**

14. [ ] Audit the custom worker entry — the `router.fetch()` response must pass
        through as a **stream** (`new Response(response.body, response)`); remove
        any `.text()`/`.arrayBuffer()`/`HTMLRewriter` buffering from the Rango
        path (keep it only on legacy/proxy branches). See §10a.
15. [ ] Switch local dev to `vite dev` / `vite preview` (they stream + load
        `.dev.vars` + provide bindings); stop using `wrangler dev` for local
        verification — it gzip-buffers and kills streaming. See §10b.
16. [ ] Move build output paths from RR7's `build/` to vite's `dist/` in
        `wrangler.toml` (`assets` → `./dist/client/`) and cleanup scripts. See §10d.
17. [ ] Fix deploy to use the built config `dist/<env>/wrangler.json`
        (`no_bundle: true`), not a root `wrangler deploy` against the source
        worker entry (which can't bundle Rango's virtual modules). See §10e.
