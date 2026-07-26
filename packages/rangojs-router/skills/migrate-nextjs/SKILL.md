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
- **Partial prerendering, shipped** — the `ppr` path option caches a page's
  HTML shell and resumes only the live holes on each request; loaders stay
  fresh. The equivalent of Next's `experimental_ppr`, stable and per-route.
  See: `/ppr`
- **Composable route tree** — layouts, includes, middleware, parallels, and
  intercepts compose directly in the route definition.
  See: `/composability`, `/parallel`, `/intercept`
- **Multi-router flexibility** — support multiple routers, domain routing, and
  worker/edge-style deployment patterns.
  See: `/host-router`

## Migration Strategy

Work route-by-route, bottom-up. Start with leaf pages, then layouts, then middleware. Verify each route works before moving to the next.

### Phase 0: choose the migration boundary

Before changing routes, classify the project. This decides whether existing
database/auth code can actually carry over:

| Migration           | What stays                                               | Additional work                                                        |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Framework only      | runtime, database, auth provider                         | Next-to-Rango surface mapping in this skill                            |
| Host/runtime swap   | database and auth, but Node becomes Workers/another host | SDK/runtime compatibility, bindings, secrets, filesystem/crypto checks |
| Datastore/auth swap | host may stay, database or identity provider changes     | schema/data migration, authorization replacement, session cutover      |
| Both                | only the product behavior stays                          | all of the above, with staged parity and rollback                      |

For Cloudflare Workers, read `/cloudflare` before scaffolding. For a host,
datastore, or auth swap, also read
[backend-host-swap.md](backend-host-swap.md). Do not treat RLS policies,
database functions, provider callbacks, or secret management as incidental
route work.

## Replace imports, never shim Next

Do NOT create mock `next/*` modules, Vite aliases for `next/*`, or compatibility
wrapper components (a local `Link` that forwards `href` to `to`, a fake
`useRouter`, a stubbed `next/headers`). Shims freeze Next semantics into the
app, hide unsupported behavior until runtime, and keep `next` in the dependency
graph — the migration looks done but isn't. Replace every `next/*` import at
its call site with the real Rango API:

| Next import                                                                  | Replace with                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `next/link` `Link`                                                           | `Link` from `@rangojs/router/client` — rename `href` to `to` (see §6)                          |
| `next/navigation` `useRouter`, `usePathname`, `useSearchParams`, `useParams` | same names from `@rangojs/router/client`                                                       |
| `next/navigation` `redirect`, `notFound`                                     | `redirect`, `notFound` from `@rangojs/router`                                                  |
| `next/headers` `cookies`, `headers`                                          | `cookies()`, `headers()` from `@rangojs/router` (server-only)                                  |
| `next/cache` `revalidateTag`, `unstable_cache`                               | `updateTag`/`revalidateTag` from `@rangojs/router`; `"use cache"` (see §3 and `/use-cache`)    |
| `next/server` `NextResponse`, `NextRequest`                                  | web-standard `Response`/`Request`; middleware via `router.use()` (see §4)                      |
| `next/image` `Image`                                                         | plain `<img>` (keep explicit `width`/`height`) or your CDN's image URL — no built-in optimizer |
| `next/font`                                                                  | see `/fonts`                                                                                   |
| `next/script` `Script`                                                       | see `/scripts`                                                                                 |
| `next-themes`                                                                | `theme: true` in `createRouter` (see §10)                                                      |

If an import has no row here and no obvious Rango equivalent, stop and surface
it to the user — do not mock it to keep the build green.

Done means: `grep -rn "from ['\"]next" src/ app/` returns nothing, and `next`
is gone from `package.json`.

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

The catch-all remainder is a single string at `ctx.params.<name>` with the `/`
separators preserved — split it to recover the array Next gives you:

```typescript
// app/docs/[[...slug]]/page.tsx  ->  params.slug is string[] | undefined in Next
path("/docs/:slug*", (ctx) => {
  // "" for /docs, "a/b/c" for /docs/a/b/c
  const slug = ctx.params.slug === "" ? [] : ctx.params.slug.split("/");
  return <Docs slug={slug} />;
}, { name: "docs" });
```

`[...path]` (required, ≥1 segment) maps to `:path+`; `[[...slug]]` (optional,
matches the bare parent too) maps to `:slug*` — which binds `""` at `/docs`.

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

The `include()` name has three deliberate modes:

| Form                                            | Child route names                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `include("/", patterns)`                        | private to the included module; omitted from the app-wide generated map |
| `include("/", patterns, { name: "marketing" })` | globally registered as `marketing.home`, `marketing.pricing`, ...       |
| `include("/", patterns, { name: "" })`          | flattened into the parent map as `home`, `pricing`, ...                 |

Use the empty-string form only when the child names are intentionally global
and unique. Inside a private/namespaced module, prefer dot-local reversal or
`scopedReverse()` rather than flattening solely for convenience.

Next.js code-splits each route segment automatically. Rango's eager `include()`
bundles the group into the entry chunk; to get Next-style per-section splitting,
pass an async provider so the group loads on the first request under its prefix:

```typescript
// urls/admin.tsx: `export default adminPatterns` — loads on first /admin request
include("/admin", () => import("./urls/admin"), { name: "admin" }),
```

Route types, `href()`, and prerender still see every route in the split group.
See `/composability`.

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
  intercept("@modal", ".product", <ProductModal />, {
    when: ({ from }) => from.pathname.startsWith("/shop"),
  }),
])
```

## 3. Data Fetching

### Server component data fetching

Inline `fetch()` or direct DB calls in server components keep the same Rango
shape when the target runtime, database, driver, and authentication model remain
compatible. A Node-to-Workers or Postgres-to-D1 move is a separate migration;
run the Phase 0 audit before carrying those calls over unchanged.

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
- **Revalidation control** — `revalidate()` targets specific segments and loaders after actions
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

### Rendering-mode segment config

Next.js route segment config maps onto Rango's explicit primitives:

| Next.js segment config                              | Rango                                                        |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `dynamic = "force-static"` + `generateStaticParams` | `Static()` / `Prerender()` (see `/prerender`)                |
| `revalidate = 60` (ISR)                             | `cache({ ttl: 60, swr: ... })` on the route (see `/caching`) |
| `dynamic = "force-dynamic"`                         | the default — routes are dynamic unless you cache them       |
| `dynamicParams = true`                              | `Passthrough()` (above)                                      |
| `experimental_ppr = true`                           | the `ppr` path option (below, and `/ppr`)                    |

### Partial prerendering → the `ppr` path option

Next.js PPR statically prerenders a shell at build time and streams the parts
inside `<Suspense>` at request time. Rango ships the same model as a path
option — the shell is captured at runtime into the app cache store and resumed
on later requests, with the holes rendered fresh per request:

```typescript
// Next.js: app/products/[id]/page.tsx
export const experimental_ppr = true;
export default async function Page({ params }) {
  return (
    <ProductShell>
      <Suspense fallback={<PriceSkeleton />}>
        <LivePrice id={params.id} />
      </Suspense>
    </ProductShell>
  );
}

// Rango, step 1 — direct carry-over. Your Suspense tree IS the hole model:
// hand the un-awaited promise down, keep the boundary, add the ppr option.
// No loader, no loading(), no restructuring.
function ProductPage(ctx: HandlerContext) {
  const price = fetchPrice(ctx.params.id); // pending promise — NOT awaited
  return (
    <ProductShell>
      <Suspense fallback={<PriceSkeleton />}>
        <LivePrice price={price} /> {/* use(price) inside */}
      </Suspense>
    </ProductShell>
  );
}
path("/products/:id", ProductPage, {
  name: "product",
  ppr: { ttl: 600, swr: 120 }, // or ppr: true (default ttl 300s)
});

// Rango, step 2 (optional refinement) — promote the fetch to a loader for a
// GUARANTEED hole: loaders are masked at capture and fresh on every serve,
// even when the value resolves instantly (a raw promise that settles fast
// would bake into the shell). loading() is the loader's hole boundary.
path(
  "/products/:id",
  ProductPage,
  { name: "product", ppr: { ttl: 600, swr: 120 } },
  () => [loader(LivePriceLoader), loading(<PriceSkeleton />)],
),
```

Differences that matter during migration:

- **The Suspense/promise model carries over.** As in Next, a still-pending
  promise handed to a component that suspends under its own `<Suspense>`
  postpones at capture and becomes a hole — existing Next PPR trees keep
  working as-is, no `loading()` required. One container rule everywhere
  (handlers, handles, loaders): awaited/settled data bakes into the shell; a
  promise nested inside your data stays a live hole. For loaders, `loading()`
  selects the lane: present = guaranteed live (masked at capture, fresh every
  serve, immune to fast resolution — prefer it for per-request data); absent =
  the bake lane (the settled container bakes and is snapshot-pinned per shell,
  nested promises stay live). Identity reads (`cookies()`/`headers()`) where
  the value would bake refuse the capture by construction.
- **Shell freshness is explicit.** Next's PPR shell is fixed until the next
  build; Rango's has `ttl`/`swr`/`tags` per route, and `updateTag()` /
  `revalidateTag()` drop the shell (`revalidate()` does not — it is a data
  lever and never touches shell HTML).
- **`cookies()`/`headers()` in shell material THROW during capture** (in Next
  they silently force dynamic rendering). Per-user reads must move behind a
  `loading()` boundary (the live loader lane) or into a nested promise — the
  refusal surfaces at migration time, which is the point.
- **A store is required.** PPR needs the app-level `createRouter({ cache })`
  store to implement the shell family (`MemorySegmentCacheStore`,
  `CFCacheStore`, `VercelCacheStore`). Without one the route quietly stays
  fully dynamic with a once-per-key warning.
- **Middleware still guards every serve.** Auth middleware (global or route
  DSL) runs before any shell byte on HIT and MISS alike — no Next-style "PPR
  bypasses middleware" caveats to migrate around.

A route without `ppr` pays zero cost. See `/ppr` for the full execution matrix,
hole rules, and pitfalls.

### Revalidation: two distinct axes

Next.js conflates two things under "revalidation." Rango separates them — and
tag-based cache invalidation now maps directly.

**1. Cache invalidation (bust cached values) — direct equivalent.** Tag entries
with `cache({ tags })` or runtime `cacheTag(...tags)`. `cacheTag()` works inside a
`"use cache"` function (tags that entry) AND render-callable in a plain server
component (no `"use cache"` needed — it tags the document / PPR shell the component
renders into). Then invalidate by tag:

```typescript
// Next.js                    Rango
// revalidateTag("products")  →  await updateTag("products")  // in a server action: awaitable,
//                                                            // read-your-own-writes (next render is fresh)
//                            or  revalidateTag("products")    // in a route handler / webhook:
//                                                            // background, non-blocking (hard-purge)
```

`updateTag` is awaitable and immediate; `revalidateTag` is fire-and-forget. Both
hard-purge (the next read re-renders fresh); the only difference is awaitability —
despite the Next.js name, `revalidateTag` here is NOT stale-while-revalidate.
Built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`) index by tag. Next's
`revalidatePath` has no path-based equivalent — tag the relevant entries instead.

**2. Partial-render selection (which segments re-run after an action).** This is
NOT cache invalidation — it is `revalidate()`, controlling which segments
(layouts, paths, loaders, parallels) recompute during partial action
re-rendering:

```typescript
import { updateBlog } from "./actions/blog";

// Re-run this layout when a blog action fires
layout(BlogLayout, () => [
  revalidate((ctx) => ctx.isAction(updateBlog) || undefined),
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

The two axes compose: `updateTag()` / `revalidateTag()` bust cached values;
`revalidate()` selects which segments re-render and stream to the client after an
action.

When migrating:

- `revalidateTag(tag)` → `await updateTag(tag)` (in a server action) or
  `revalidateTag(tag)` (in a route handler / webhook). Effectively 1:1.
- `revalidatePath(path)` → no path-based equivalent; tag the entries on that
  route (`cache({ tags })` / `cacheTag(...)`) and invalidate by tag.
- To also force specific segments to re-render after the action (independent of
  cache busting), attach a `revalidate()` rule at those segment boundaries.

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

### "Instant navigations" (Link prefetching)

Next.js's instant navigations — `<Link>` auto-prefetch feeding the client
router cache — map to Rango's prefetch system: per-Link
`prefetch="viewport" | "hover" | "none"` (or the router-wide `defaultPrefetch`
option) warms the target's partial RSC payload before the click, and a click
on a warmed link commits the prefetched payload as a whole — the complete
page lands instantly, no fetch waterfall. Prefetched entries survive being
used (they re-arm in place) and expire by `prefetchCacheTTL`; actions and
`invalidateClientCache()` flush them so a stale payload is never committed.

```tsx
<Link to="/product/widget" prefetch="viewport">
  Widget
</Link>
```

Two differences from Next.js worth knowing: the trigger is an explicit choice
(viewport vs hover vs none) rather than an internal scheduler, and container
opt-outs exist for whole DOM sections (`data-prefetch-scope="none"`). See
`/links` → "Prefetch boundaries".

For **dashboard / admin / settings-shaped sections** — high navigation
frequency inside one layout, mostly tab/param/filter switches — also consider
porting that route group to `clientUrls()` (`/client-urls`): the definition
matches in the browser (instant optimistic pending, no server round-trip to
start a transition) and browser-run `revalidate()` predicates hold data across
switches that don't invalidate it, which is the fastest transition shape Rango
has. Server-component routes and `clientUrls()` groups compose in one tree.

## 7. Server Actions

Server actions work the same way — `"use server"` directive, `useActionState`, form actions. No migration needed for action logic.

Key difference: in Rango, route middleware does NOT wrap action execution. Actions only see global middleware context. Use `getRequestContext()` in actions to access `ctx.set()`/`ctx.get()`.

Next.js's `revalidateTag()` maps directly: tag entries via `cache({ tags })` / `cacheTag(...)`, then invalidate. **In a server action use `await updateTag(tag)`** — it is read-your-own-writes, so the action's own re-render sees fresh data; `revalidateTag(tag)` is a background (non-blocking) hard-purge and is NOT read-your-own-writes, so reserve it for route handlers / webhooks (calling it from an action can leave that action's re-render stale). `revalidatePath()` has no path-based equivalent — tag the route's entries instead. Separately, to force specific matched segments (path/layout/parallel/intercept) and their loaders to re-render after an action, attach a `revalidate(({ actionId }) => ...)` rule to that segment or loader registration. See `/server-actions` for the full pattern (validation, error handling, file uploads), `/caching` for tag invalidation, and `/loader` for revalidation rule semantics.

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

`generateMetadata({ params })` — DATA-derived, document-blocking metadata —
maps to a Meta push from the LOADER that owns the data, plus
`{ stream: "navigation" }` for the blocking-until-in-head part:

```typescript
// Next.js: export async function generateMetadata({ params }) {
//   const product = await getProduct(params.slug);
//   return { title: product.name };
// }

// Rango: push from the loader; the flag makes the document render await it,
// so the title is in the SSR'd <head> like generateMetadata guarantees.
export const ProductLoader = createLoader(async (ctx) => {
  "use server";
  const product = await getProduct(ctx.params.slug);
  ctx.use(Meta)({ title: product.name });
  return product;
});

path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader, { stream: "navigation" }),
]);
```

Without the flag the push still applies, but a slow loader's title lands
post-hydration instead of in the document — see `/loader` → "Writing Handles
from Loaders" for the delivery race.

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

Response routes treat returned responses as control-flow responses. A thrown
`RouterError` becomes a structured API error. Do not assume every Next
`NextResponse`/throw pattern maps identically:

| In a response route             | Use                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| custom status/body/headers      | `return new Response(...)`                                           |
| structured thrown API error     | `throw new RouterError(...)`                                         |
| intentional off-origin redirect | validate the target, then `return redirect(url, { external: true })` |

Rango guards every browser-followed cross-origin `Location`. A raw unbranded
cross-origin 3xx is rewritten to the app root; `{ external: true }` is the
explicit, auditable opt-out for OAuth/SSO/payment callbacks. Never set it on an
unvalidated user-provided URL.

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

1. [ ] Classify the migration boundary (framework, host/runtime, datastore/auth, or both)
2. [ ] Set up Vite config with `rango()` plugin (and read `/cloudflare` for Workers)
3. [ ] Create Document component (replaces root `<html>` layout)
4. [ ] Create `router.tsx` with `createRouter()`
5. [ ] Convert file-based routes to `urls()` DSL in `urls.tsx`
6. [ ] Migrate layouts to `layout()` with `<Outlet />`
7. [ ] Convert data fetching to `createLoader()` + `ctx.use()`
8. [ ] Migrate `middleware.ts` to `router.use()` (auth, guards, logging)
9. [ ] Replace `next/link` with `Link` from `@rangojs/router/client`; keep
       "instant navigations" via `prefetch="viewport"`/`defaultPrefetch` (§6)
10. [ ] Convert loading/error files to `loading()` / `errorBoundary()`
11. [ ] Migrate API routes to `path.json()` / `path.text()`
12. [ ] Update metadata to use `Meta` handle + `<MetaTags />` in document head
        (`generateMetadata` → loader push + `{ stream: "navigation" }`)
13. [ ] Replace `next-themes` with `theme: true` in createRouter (see `/theme`)
14. [ ] Map rendering-mode segment config: `revalidate = N` → `cache({ ttl })`,
        `force-static` → `Static()`/`Prerender()`, `experimental_ppr` → the
        `ppr` path option (loader + `loading()` as the hole)
15. [ ] Run `npx rango generate src/` to generate route types
16. [ ] Verify no shims: `grep -rn "from ['\"]next" src/ app/` returns nothing,
        no mock `next/*` modules or aliases exist, and `next` is out of
        `package.json`
