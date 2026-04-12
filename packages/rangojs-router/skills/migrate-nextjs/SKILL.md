---
name: migrate-nextjs
description: Migrate a Next.js App Router project to @rangojs/router. Use when the user asks to "migrate from Next.js", "convert Next.js to Rango", "replace Next.js", or has a Next.js app they want to port.
argument-hint: [path-to-nextjs-app]
---

# Migrate from Next.js App Router to @rangojs/router

## Why Rango

Common reasons to migrate:

- **Server components by default** — keep data fetching on the server without
  framework-specific file conventions.
  See: `/router-setup`, `/route`
- **Django-style route definition** — `urls()`, `path()`, and `layout()` make
  the route tree explicit instead of spreading routing across many special files.
  See: `/route`, `/layout`
- **Named routes** — reverse URLs by route name instead of hard-coding path
  strings throughout the app.
  See: `/links`, `/typesafety`
- **Clear execution model** — request scope, render scope, segment boundaries,
  and shared `ctx` behavior are explicit in the routing model.
  See: `/middleware`, `/loader`
- **Live data layer** — `createLoader()` and `loader()` keep data fresh
  independently of cached UI. A route can serve cached segments while loaders
  still resolve live on every request.
  See: `/loader`, `/caching`, `/cache-guide`
- **Explicit caching model** — `cache()` DSL, `revalidate()`, `use cache`, and
  custom cache stores make caching and revalidation behavior visible in code.
  See: `/caching`, `/cache-guide`, `/use-cache`
- **Build-time rendering** — `Static()` and `Prerender()` provide explicit
  build-time rendering instead of mixing rendering and caching behind conventions.
  See: `/prerender`
- **Composable route tree** — layouts, includes, middleware, parallels, and
  intercepts compose directly in the route definition.
  See: `/composability`, `/parallel`, `/intercept`
- **Multi-router flexibility** — support multiple routers, domain routing, and
  worker/edge-style deployment patterns.
  See: `/host-router`

## Migration Strategy

Work route-by-route, bottom-up. Start with leaf pages, then layouts, then middleware. Verify each route works before moving to the next.

## 1. Project Setup

Replace Next.js tooling with Vite + Rango:

```bash
npm remove next @next/env
npm install @rangojs/router @vitejs/plugin-react
npm install -D vite
```

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [rango()],
});
```

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

export default createRouter({
  document: Document,
}).routes(urlpatterns);
```

The Document component replaces `app/layout.tsx`'s `<html>` wrapper. See `/router-setup` for full config options.

## 2. Route Mapping

### File-based → URL pattern DSL

| Next.js file path               | Rango equivalent                                           |
| ------------------------------- | ---------------------------------------------------------- |
| `app/page.tsx`                  | `path("/", HomePage, { name: "home" })`                    |
| `app/about/page.tsx`            | `path("/about", AboutPage, { name: "about" })`             |
| `app/blog/[slug]/page.tsx`      | `path("/blog/:slug", BlogPost, { name: "blogPost" })`      |
| `app/shop/[...path]/page.tsx`   | `path("/shop/:path+", CatchAll, { name: "shopCatchAll" })` |
| `app/docs/[[...slug]]/page.tsx` | `path("/docs/:slug*", Docs, { name: "docs" })`             |

### Layouts

```typescript
// Next.js: app/dashboard/layout.tsx
export default function DashboardLayout({ children }) {
  return <div className="dashboard">{children}</div>;
}

// Rango:
import { Outlet } from "@rangojs/router/client";

function DashboardLayout() {
  return (
    <div className="dashboard">
      <Outlet />
    </div>
  );
}

// In urls.tsx:
layout(<DashboardLayout />, () => [
  path("/dashboard", DashboardIndex, { name: "dashboard" }),
  path("/dashboard/settings", Settings, { name: "settings" }),
])
```

Key difference: Rango layouts use `<Outlet />` instead of `{children}`. Layouts are server components by default.

### Dynamic layouts (with data)

```typescript
// Next.js: app/dashboard/layout.tsx
export default async function DashboardLayout({ children }) {
  const user = await getUser();
  return <Shell user={user}>{children}</Shell>;
}

// Rango: handler function layout
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

### Route groups

Next.js `app/(marketing)/page.tsx` route groups have no URL segment. In Rango, just organize with `include()`:

```typescript
// src/urls/marketing.tsx
export const marketingPatterns = urls(({ path }) => [
  path("/", LandingPage, { name: "landing" }),
  path("/pricing", PricingPage, { name: "pricing" }),
]);

// src/urls.tsx
include("/", marketingPatterns, { name: "marketing" }),
```

### Parallel routes

In Next.js, `@sidebar` and `@main` are both named slots. In Rango, the main content
renders through `<Outlet />` (the path handler), and only extra slots use `parallel()` +
`<ParallelOutlet />`:

```typescript
// Next.js: app/layout.tsx renders {sidebar} and {children}
//          app/@sidebar/page.tsx provides the sidebar slot
//          app/page.tsx provides the main content

// Rango: main content is the path handler, sidebar is a parallel slot
layout(
  () => (
    <div className="dashboard">
      <ParallelOutlet name="@sidebar" />
      <Outlet />
    </div>
  ),
  () => [
    parallel({
      "@sidebar": <Sidebar />,
    }),
    path("/dashboard", DashboardPage, { name: "dashboard" }),
  ],
)
```

Only add `parallel()` slots for content that renders alongside the main route.
The main content always goes through `<Outlet />` via the `path()` handler.

### Intercepting routes

```typescript
// Next.js: app/(.)product/[id]/page.tsx
// (convention: (.) means same level, (..) parent level)

// Rango: explicit intercept in layout
layout(<ShopLayout />, () => [
  path("/product/:id", ProductPage, { name: "product" }),
  intercept("@modal", ".product", <ProductModal />, () => [
    when(({ from }) => from.pathname.startsWith("/shop")),
  ]),
])
```

## 3. Data Fetching

### Server component data fetching

Inline `fetch()` or direct DB calls in server components work as-is — no migration needed:

```typescript
// Next.js:
async function ProductPage({ params }) {
  const product = await fetch(`/api/products/${params.slug}`).then(r => r.json());
  return <div>{product.name}</div>;
}

// Rango: same pattern, params come from ctx
const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await fetch(`/api/products/${ctx.params.slug}`).then(r => r.json());
  return <div>{product.name}</div>;
};
```

### When to use createLoader

Loaders are Rango's live data layer. Use them when you need:

- **Client-side data refresh** — `useLoader()` in client components for reactive data
- **Per-loader caching** — opt in with `loader(MyLoader, () => [cache({ ttl: 60 })])`; loaders stay live by default
- **Revalidation control** — `revalidate()` targets specific loaders after actions
- **Loading skeletons** — `loading()` shows a Suspense fallback while loaders resolve

```typescript
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  return await db.getProduct(ctx.params.slug);
});

// In urls:
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),
])
```

If the existing fetch pattern works and you don't need these features, leave it as-is. See `/loader` for full API.

### generateStaticParams → Prerender + Passthrough

Plain `Prerender` only serves the listed params — unlisted params get no live
fallback in production (the handler is evicted). If the Next.js route serves
params outside the generated set at runtime, wrap with `Passthrough()`:

```typescript
// Next.js:
export async function generateStaticParams() {
  return [{ slug: "a" }, { slug: "b" }];
}

// Rango (build-only, no live fallback for unlisted params):
import { Prerender } from "@rangojs/router";

export const ProductDef = Prerender<{ slug: string }>(
  async () => [{ slug: "a" }, { slug: "b" }],
  async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    return <ProductPage product={product} />;
  },
);

// Rango (with live fallback — matches Next.js dynamicParams behavior):
import { Prerender, Passthrough } from "@rangojs/router";

const ProductDef = Prerender<{ slug: string }>(
  async () => [{ slug: "a" }, { slug: "b" }],
  async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    if (!product) return ctx.passthrough();
    return <ProductPage product={product} />;
  },
);

export const Product = Passthrough(ProductDef, async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  return <ProductPage product={product} />;
});
```

Use `Passthrough()` whenever the Next.js route has `dynamicParams: true` (the
default) or serves an open-ended param space. See `/prerender` for full API.

### Revalidation: different model

Next.js uses path/tag-based cache invalidation (`revalidatePath`, `revalidateTag`)
to bust cached responses. Rango does not currently have a direct equivalent.

In Rango, separate these two concepts:

**Partial rendering revalidation** — `revalidate()` controls which segments
(layouts, paths, loaders, parallels) should re-run during partial action
re-rendering. This is about the segment tree, not cache invalidation:

```typescript
// Re-run this layout when a blog action fires
layout(BlogLayout, () => [
  revalidate(({ actionId }) => actionId?.includes("updateBlog") ?? false),
  path("/blog/:slug", BlogPost, { name: "blogPost" }),
]);

// Re-run sidebar parallel when params change
parallel({ "@sidebar": BlogSidebar }, () => [
  revalidate(
    ({ currentParams, nextParams }) => currentParams.slug !== nextParams.slug,
  ),
]);
```

**Server-side caching** — `cache()` DSL, loader-level `cache()`, and `"use cache"`
control what gets cached and for how long. This is separate from `revalidate()`:

```typescript
cache({ ttl: 60, swr: 300 }, () => [
  path("/blog/:slug", BlogPost, { name: "blogPost" }),
]);
```

The key shift is:

- Next.js asks "which cached path or tag should I invalidate?"
- Rango asks "which segments should re-run after this action?"

When migrating `revalidatePath()` / `revalidateTag()` usage, the Rango version
usually is not a 1:1 API replacement. Instead, decide which layouts, routes,
loaders, or parallels should recompute after an action and declare
`revalidate()` at those segment boundaries.

## 4. Middleware

Next.js `middleware.ts` wraps the entire request — including server actions.
The direct equivalent is `router.use()`, not the DSL `middleware()`:

```typescript
// Next.js: middleware.ts (file-convention, wraps all requests)
import { NextResponse } from "next/server";

export function middleware(request) {
  if (!request.cookies.get("session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}
export const config = { matcher: ["/dashboard/:path*"] };

// Rango: split into initialisation (global) + guard (scoped)
import { redirect, cookies } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";

// Runs on every request — resolves the session for all routes
const authInit: Middleware = async (ctx, next) => {
  const session = cookies().get("session")?.value;
  if (session) {
    const user = await verifySession(session);
    ctx.set("user", user);
  }
  await next();
};

// Scoped guard — redirects unauthenticated users
const requireAuth: Middleware = async (ctx, next) => {
  if (!ctx.get("user")) {
    return redirect("/login");
  }
  await next();
};

const router = createRouter({})
  .use(authInit) // all routes — sets ctx user
  .use("/dashboard/*", requireAuth) // dashboard only — redirects
  .routes(urlpatterns);
```

**Rango has two middleware levels with different scopes:**

|                    | `router.use()`                       | `middleware()` in DSL           |
| ------------------ | ------------------------------------ | ------------------------------- |
| Wraps              | Entire request (actions + rendering) | Rendering only                  |
| Use for            | Auth guards, logging, CORS           | Context shaping, render headers |
| Next.js equivalent | `middleware.ts`                      | No direct equivalent            |

Use `router.use()` for auth guards — it wraps the full request including actions.
DSL `middleware()` can also guard rendering (e.g. redirect unauthenticated users
away from a page), but it does not protect actions on that route. For full auth
coverage, prefer `router.use()`. See `/middleware`.

## 5. Loading & Error States

```typescript
// Next.js: app/dashboard/loading.tsx
export default function Loading() { return <Skeleton />; }

// Rango:
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  loading(<Skeleton />),
])
```

```typescript
// Next.js: app/dashboard/error.tsx wraps all routes under /dashboard
"use client";
export default function Error({ error, reset }) { ... }

// Rango: errorBoundary wrapping a group of routes
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

```typescript
// Next.js: app/not-found.tsx
export default function NotFound() { ... }

// Rango (app-level — no route match, or notFound() without a boundary):
createRouter({
  notFound: ({ pathname }) => <NotFoundPage pathname={pathname} />,
})

// Rango (route-level — notFoundBoundary wrapping a group of routes):
layout(<ShopLayout />, () => [
  notFoundBoundary(({ notFound: info }) => (
    <div>
      <h2>Not Found</h2>
      <p>{info.message}</p>
    </div>
  )),
  path("/product/:slug", ProductPage, { name: "product" }),
  path("/product/:slug/reviews", ReviewsPage, { name: "reviews" }),
])
```

Both `errorBoundary()` and `notFoundBoundary()` catch errors from all
children in their scope — handlers, loaders, and nested segments.

## 6. Navigation

| Next.js                         | Rango                                             |
| ------------------------------- | ------------------------------------------------- |
| `import Link from "next/link"`  | `import { Link } from "@rangojs/router/client"`   |
| `<Link href="/about">`          | `<Link to="/about">`                              |
| `useRouter().push("/about")`    | `useRouter().push("/about")`                      |
| `useRouter().replace("/about")` | `useRouter().replace("/about")`                   |
| `usePathname()`                 | `usePathname()` from `@rangojs/router/client`     |
| `useSearchParams()`             | `useSearchParams()` from `@rangojs/router/client` |
| `redirect("/login")` (server)   | `redirect("/login")` from `@rangojs/router`       |

## 7. Server Actions

Server actions work the same way — `"use server"` directive, `useActionState`, form actions. No migration needed for action logic.

Key difference: in Rango, route middleware does NOT wrap action execution. Actions only see global middleware context. Use `getRequestContext()` in actions to access `ctx.set()`/`ctx.get()`.

## 8. Metadata / Head

Rango uses the `Meta` handle + `<MetaTags />` client component:

```typescript
// Next.js: export const metadata = { title: "Home" }
// Next.js: export function generateMetadata({ params }) { ... }

// Rango: Meta handle in handlers (server), MetaTags in document <head> (client)
import { Meta } from "@rangojs/router";

const HomePage: Handler<"home"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Home" });
  meta({ name: "description", content: "Welcome to the site" });
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

Later routes override earlier ones for the same meta key (deduplication).

## 9. API Routes

```typescript
// Next.js: app/api/users/route.ts
export async function GET(request) { ... }

// Rango: response routes
path.json("/api/users", async (ctx) => {
  const users = await db.getUsers();
  return users;
}, { name: "apiUsers" })

path.text("/api/health", () => "ok", { name: "apiHealth" })
```

See `/response-routes` for full API.

## 10. Theme / Dark Mode

If the Next.js app uses `next-themes` or a custom theme provider, replace it
with Rango's built-in theme system (FOUC prevention included):

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

## Migration Checklist

1. [ ] Set up Vite config with `rango()` plugin
2. [ ] Create Document component (replaces root `<html>` layout)
3. [ ] Create `router.tsx` with `createRouter()`
4. [ ] Convert file-based routes to `urls()` DSL in `urls.tsx`
5. [ ] Migrate layouts to `layout()` with `<Outlet />`
6. [ ] Convert data fetching to `createLoader()` + `ctx.use()`
7. [ ] Migrate `middleware.ts` to `router.use()` (auth, guards, logging)
8. [ ] Replace `next/link` with `Link` from `@rangojs/router/client`
9. [ ] Convert loading/error files to `loading()` / `errorBoundary()`
10. [ ] Migrate API routes to `path.json()` / `path.text()`
11. [ ] Update metadata to use `Meta` handle + `<MetaTags />` in document head
12. [ ] Replace `next-themes` with `theme: true` in createRouter (see `/theme`)
13. [ ] Run `npx rango generate src/` to generate route types
