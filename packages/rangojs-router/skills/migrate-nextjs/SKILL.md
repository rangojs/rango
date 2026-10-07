---
name: migrate-nextjs
description: Migrate a Next.js App Router project to @rangojs/router. Use when the user asks to "migrate from Next.js", "convert Next.js to Rango", "replace Next.js", or has a Next.js app they want to port.
argument-hint: [path-to-nextjs-app]
---

# Migrate from Next.js App Router to @rangojs/router

This skill maps a Next.js App Router project onto Rango: project setup, the
`app/` file conventions to the `urls()` DSL, data fetching and rendering modes
(SSG, ISR, PPR), middleware, navigation, server actions, metadata, API routes,
and theming. Use it when porting a Next.js app, or when a Next.js habit needs a
Rango equivalent. For a side-by-side evaluation rather than a port, see
`/comparison`; for React Router or Remix apps, see `/migrate-react-router`.

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
  HTML shell and resumes its holes per request: loaders without `ssr: false`,
  read under `loading()` or an inline `<Suspense>`. Handler output bakes into
  the shell. It maps to Next's `experimental_ppr`, stable and per-route, but
  holes come from loaders, not from any `<Suspense>`.
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
| `next/dynamic` `dynamic(() => import(...), { ssr: false })`                  | render it after mount in a `"use client"` component (see the note below)                       |

`next/dynamic`'s `{ ssr: false }` keeps a component out of server rendering:
render it only after mount in a `"use client"` component (a `useEffect` flag,
with `React.lazy()` if its code should split out). Do not map it to
`loader(L, { ssr: false })`, which does the opposite: the server settles that
loader before the first flush, and under `ppr` it bakes into the shell.

If an import has no row here and no obvious Rango equivalent, stop and surface
it to the user — do not mock it to keep the build green.

Done means: `grep -rn "from ['\"]next" src/ app/` returns nothing, and `next`
is gone from `package.json`.

## 1. Project Setup

Replace Next.js tooling with Vite + Rango:

```bash
npm remove next @next/env
npm install @rangojs/router   # keep react and react-dom
npm install -D vite
```

`rango()` already includes `@vitejs/plugin-rsc` and supplies the client and
server entries. Add `@vitejs/plugin-react` only if you want Fast Refresh or the
React Compiler (see `/react-compiler`).

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

export const router = createRouter({
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
| `include("/", patterns, { name: "marketing" })` | globally registered as `marketing.landing`, `marketing.pricing`, ...    |
| `include("/", patterns, { name: "" })`          | flattened into the parent map as `landing`, `pricing`, ...              |

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
    when: ({ from }) => from.url.pathname.startsWith("/shop"),
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
  const product = await fetch(`https://api.example.com/products/${params.slug}`).then(r => r.json());
  return <div>{product.name}</div>;
}

// Rango: same pattern, params come from ctx
import type { Handler } from "@rangojs/router";

const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await fetch(`https://api.example.com/products/${ctx.params.slug}`).then(r => r.json());
  return <div>{product.name}</div>;
};
```

If the Next page fetched its own `/api/...` route, call the underlying service
function directly instead of making a request back to the same app (see
[backend-host-swap.md](backend-host-swap.md#extract-shared-server-services)).

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
import { Prerender, Passthrough, notFound } from "@rangojs/router";

// Keep the definition exported: the Vite plugin injects the stable id only
// into `export const X = Prerender(...)` (or `const X = ...; export { X }`).
export const ProductDef = Prerender<{ slug: string }>(
  async () => [{ slug: "a" }, { slug: "b" }],
  async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    if (!product) return ctx.passthrough();
    return <ProductPage product={product} />;
  },
);

export const Product = Passthrough(ProductDef, async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  if (!product) notFound();
  return <ProductPage product={product} />;
});

// In urls:
path("/products/:slug", Product, { name: "product" });
```

Use `Passthrough()` whenever the Next.js route has `dynamicParams: true` (the
default) or serves an open-ended param space. See `/prerender` for full API.

### Rendering-mode segment config

Next.js route segment config maps onto Rango's explicit primitives:

| Next.js segment config                              | Rango                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dynamic = "force-static"` + `generateStaticParams` | `Static()` / `Prerender()` (see `/prerender`)                                                                             |
| `revalidate = 60` (ISR)                             | `cache({ ttl: 60, swr: ... })` on the route (see `/caching`), or on-demand prerender with `onDemand: { ttl: 60 }` (below) |
| `dynamic = "force-dynamic"`                         | the default — routes are dynamic unless you cache them                                                                    |
| `dynamicParams = true`                              | `Passthrough()` (above)                                                                                                   |
| `experimental_ppr = true`                           | the `ppr` path option (below, and `/ppr`)                                                                                 |

### On-demand ISR → `Prerender(..., { onDemand })` + `router.prerender()`

A Next.js page with `generateStaticParams` refreshed by `revalidatePath()` or
`revalidateTag()` from a CMS webhook maps to an on-demand prerender route. The
route opts in, a store holds refreshed payloads, and the webhook re-renders the
page instead of invalidating it:

```typescript
// Next.js:
export const revalidate = 3600;
export async function generateStaticParams() {
  return (await getFeatured()).map((p) => ({ id: p.id }));
}
// app/api/revalidate/route.ts
revalidatePath(`/products/${id}`);
revalidateTag(`product:${id}`);

// Rango:
export const ProductPage = Prerender<{ id: string }>(
  async () => (await getFeatured()).map((p) => ({ id: p.id })),
  async (ctx) => <Product data={await getProduct(ctx.params.id)} />,
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.id}`] } },
);

// router: createRouter({ prerender: { store, ttl, onRevalidate? } })
// webhook (route handler, cron or queue):
const prerender = router.prerender({ env, ctx });
await prerender(`/products/${id}`); // revalidatePath
await prerender.markStale([`product:${id}`]); // revalidateTag
```

| Next.js                               | Rango                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `revalidatePath(path)` on an ISR page | `await router.prerender({ env, ctx })(path)`: renders now, serves the new payload next request      |
| `revalidateTag(tag)` on ISR pages     | `router.prerender({ env, ctx }).markStale([tag])`: marks only; a stale hit schedules `onRevalidate` |
| `revalidate = N` (time-based ISR)     | `onDemand: { ttl: N }` + `onRevalidate`; `ttl` is soft, entries never expire                        |
| `dynamicParams = false`               | plain on-demand `Prerender`: an unknown param 404s until something refreshes it                     |
| `dynamicParams = true`                | wrap it in `Passthrough()`: unknown params render live until refreshed                              |

A page whose item was deleted. In the Pages Router, `getStaticProps` returns
`{ notFound: true }` on a revalidation: "With `notFound: true`, the page will
return a `404` even if there was a successfully generated page before. This is
meant to support use cases like user-generated content getting removed by its
author. Note, `notFound` follows the same `revalidate` behavior described
here." In Rango a `notFound()` anywhere in the on-demand render (the route
handler, a layout or slot handler, any server component) does the same on the
next `prerender(path)`: the result is `{ ok: true, status: "removed" }`, the
page answers 404 instead of the page or its build-time entry, and the removal
is rechecked per the route's `ttl`, as Next's is per `revalidate`. When the
data source may be failing, throw anything else: that keeps the page.
`prerender.remove(path)` removes without rendering, for a webhook that already
knows the item is gone, and is permanent until a `prerender(path)` renders the
page again. See `/prerender` → "Remove a page".

Three differences to plan for:

- Prerender tags are their own namespace. `updateTag()` / `revalidateTag()`
  from `@rangojs/router` purge the runtime cache and never reach on-demand
  entries; `markStale()` never reaches the runtime cache.
- A refresh is requestless: `cookies()` / `headers()` in the page make it
  return `skipped-personalized`, and `ctx.env` is the live env you pass.
- `markStale()` does not re-render: without `onRevalidate` or a cron calling
  `prerender(target, { onlyIfStale: true })` (the runner from
  `router.prerender({ env, ctx })`), a marked page keeps
  serving its old payload.

See `/prerender` → "On-demand refresh (ISR)" for the store options, the serve
table and the rules.

### Partial prerendering → the `ppr` path option

Next.js PPR statically prerenders a shell at build time and streams the parts
inside `<Suspense>` at request time. Rango ships a similar model as a path
option — the shell is captured at runtime into the app cache store and resumed
on later requests, with the holes rendered fresh per request. The difference is
what counts as a hole: in Rango everything a handler produces is shell
material, as it is under `cache()`, including a promise it hands to a component
under `<Suspense>`. A live hole is loader data:

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

// Rango: the direct carry-over BAKES. Under ppr the capture awaits a promise
// the handler hands down (bounded by ppr.captureTimeout), and every shell HIT
// shows the captured price.
import { Suspense } from "react";
import type { HandlerContext } from "@rangojs/router";

function ProductPage(ctx: HandlerContext) {
  const price = fetchPrice(ctx.params.id); // awaited at capture, then frozen
  return (
    <ProductShell>
      <Suspense fallback={<PriceSkeleton />}>
        <LivePrice price={price} /> {/* use(price) inside */}
      </Suspense>
    </ProductShell>
  );
}

// Rango, live price: a loader without ssr: false, read with
// useLoader(LivePriceLoader) in a client component. loading() (or an inline
// <Suspense> around the reader) is the hole boundary (/ppr → The loader lane
// rule).
function ProductPageLive() {
  return (
    <ProductShell>
      <LivePriceFromLoader /> {/* "use client": useLoader(LivePriceLoader) */}
    </ProductShell>
  );
}
path(
  "/products/:id",
  ProductPageLive,
  { name: "product", ppr: { ttl: 600, swr: 120 } }, // or ppr: true (ttl 300s)
  () => [loader(LivePriceLoader), loading(<PriceSkeleton />)],
),
```

Differences that matter during migration:

- **Handler output bakes; loader data is the hole.** Unlike Next, a pending
  promise the handler hands to a component under `<Suspense>` does NOT make a
  hole. Everything a handler produces — that promise, an async server
  component, a nested promise in a handle it pushes, a loader it awaits — is
  awaited at capture (bounded by `ppr.captureTimeout`) and served frozen for
  the shell's lifetime; a shell HIT never runs a handler. Keep the parts that
  must be fresh in loaders without `ssr: false`, read with `useLoader` under
  `loading()` or an inline `<Suspense>`; inside an `ssr: false` loader, return
  them as nested promises. For loaders, `ssr: false` (not `loading()`) selects
  the lane — see `/ppr` → The loader lane rule.
- **Shell freshness is explicit.** Next's PPR shell is fixed until the next
  build; Rango's has `ttl`/`swr`/`tags` per route, and `updateTag()` /
  `revalidateTag()` drop the shell (`revalidate()` does not — it is a data
  lever and never touches shell HTML). Under a route `cache()`, the shell
  lives no longer than that entry: its ttl/swr are capped by the entry's (dev
  warns when an explicit `ppr` window is reduced). A route `cache({ key })`
  gives one shell per key value, and `cache(false)` or a false `condition()`
  means no shell.
- **Request-scoped reads in shell material refuse the capture** (in Next they
  silently force dynamic rendering). `cookies()`, `headers()`,
  `ctx.request.headers`, a `{ cache: false }` variable, and `ctx.dynamic()` refuse it anywhere the
  capture waits: a handler, a promise it passes or pushes, an async component,
  a loader it awaits. Per-user reads must move into a live loader (no
  `ssr: false`; a nested promise does not help). A normal `ctx.get()` value is
  not guarded and bakes as the capturing request's value. The refusal surfaces
  at migration time, which is the point.
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
renders into, and the route `cache()` entry it renders inside). Then invalidate by tag:

```typescript
// Next.js                    Rango
// revalidateTag("products")  →  await updateTag("products")  // in a server action: awaitable,
//                                                            // read-your-own-writes (next render is fresh)
//                            or  revalidateTag("products")    // in a route handler / webhook:
//                                                            // background, non-blocking (evicts)
```

`updateTag` is awaitable and immediate; `revalidateTag` is fire-and-forget. Both
evict (despite the Next.js name, `revalidateTag` here is NOT
stale-while-revalidate), and the request that calls either reads its own
writes. `updateTag()` also waits for the durable write and rejects when it
fails; `revalidateTag()` runs it in the background. The mutating user's next
requests skip the stores' per-isolate PPR shell memos via the fresh-reads
cookie (`rango-state-fresh`); other users, and other locations on
`CFCacheStore`, see the invalidation once the memo refreshes and KV
propagates (`/caching` → "The fresh-reads cookie").
Built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`, `VercelCacheStore`)
index by tag. Next's
`revalidatePath` has no path-based equivalent for runtime-cached data — tag the
relevant entries instead. For a prerendered ISR page it is
`router.prerender({ env, ctx })(path)` (see "On-demand ISR" above).

**2. Partial-render selection (which segments re-run after an action).** This is
NOT cache invalidation — it is `revalidate()`, controlling which segments
(layouts, paths, loaders, parallels) recompute during partial action
re-rendering:

```typescript
import { updateBlog } from "./actions/blog";

// Re-run this layout when a blog action fires (layouts above the route are
// skipped after actions by default; undefined defers otherwise)
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
- `revalidatePath(path)` on an ISR page → `router.prerender({ env, ctx })(path)`
  (on-demand prerender, §3); on runtime-cached data, no path-based
  equivalent; tag the entries on that
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

// Rango: errorBoundary wrapping a group of routes. The fallback renders on the
// server and receives only `error` — there is no `reset` (a server render
// cannot be retried in place; the user navigates away or reloads).
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

For client-side render errors with a "Try again" button (Next's `reset`), wrap
the client subtree in `ErrorBoundary` from `@rangojs/router/client`; its
function fallback receives `{ error, reset }`:

```tsx
"use client";
import { ErrorBoundary } from "@rangojs/router/client";

export function ChartPanel() {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <div>
          <p>{error.message}</p>
          <button onClick={reset}>Try again</button>
        </div>
      )}
    >
      <Chart />
    </ErrorBoundary>
  );
}
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

| Next.js                                              | Rango                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import Link from "next/link"`                       | `import { Link } from "@rangojs/router/client"`                                                                                                                                                         |
| `<Link href="/about">`                               | `<Link to="/about">`                                                                                                                                                                                    |
| `useRouter().push("/about")`                         | `useRouter().push("/about")`                                                                                                                                                                            |
| `useRouter().replace("/about")`                      | `useRouter().replace("/about")`                                                                                                                                                                         |
| `useRouter().back()` / `refresh()` / `prefetch(url)` | same methods on `useRouter()` from `@rangojs/router/client`                                                                                                                                             |
| `useParams()`                                        | `useParams()` from `@rangojs/router/client` (or `ctx.params` in a server handler)                                                                                                                       |
| `usePathname()`                                      | `usePathname()` from `@rangojs/router/client`                                                                                                                                                           |
| `useSearchParams()`                                  | `useSearchParams()` from `@rangojs/router/client` — returns an RR-style TUPLE, so destructure the reader: `const [searchParams] = useSearchParams()`; the second element is a setter Next does not have |
| `redirect("/login")` (server)                        | `redirect("/login")` from `@rangojs/router`                                                                                                                                                             |

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

Server actions work the same way — `"use server"` directive, `useActionState`, form actions. No migration needed for action logic. Keep passing the imported action itself to `<form action={...}>` or `useActionState(action, initial)` (not a client-side closure around it) so the form still submits with JavaScript disabled.

Key difference: in Rango, route middleware does NOT wrap action execution. Actions only see global middleware context. Use `getRequestContext()` in actions to access `ctx.set()`/`ctx.get()`.

Next.js's `revalidateTag()` maps directly: tag entries via `cache({ tags })` / `cacheTag(...)`, then invalidate. **In a server action use `await updateTag(tag)`** — it is read-your-own-writes, so the action's own re-render sees fresh data, and it rejects when the store's durable write fails; `revalidateTag(tag)` is a background (non-blocking) hard-purge for route handlers / webhooks. The request that calls `revalidateTag()` also reads its own writes, but a failed durable write only reaches `onError`. `revalidatePath()` has no path-based equivalent — tag the route's entries instead. Separately, the route, the segments inside its `path()`, and all loaders already re-run after every action; layouts and parallels above the route are skipped. To re-render one of those skipped segments after an action, attach `revalidate((ctx) => ctx.isAction(updateBlog) || undefined)` to it; to narrow a loader or route segment to one action, use `revalidate((ctx) => (ctx.isAction() ? ctx.isAction(updateBlog) : undefined))` (match the imported action by reference, as in §3). See `/server-actions` for the full pattern (validation, error handling, file uploads), `/caching` for tag invalidation, and `/loader` for revalidation rule semantics.

## 8. Metadata / Head

Rango uses the `Meta` handle + `<Html.Meta />` client component:

```typescript
// Next.js: export const metadata = { title: "Home" }
// Next.js: export function generateMetadata({ params }) { ... }

// Rango: Meta handle in handlers (server), Html.Meta in document <head> (client)
import { Meta, type Handler } from "@rangojs/router";

const HomePage: Handler<"home"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Home" });
  meta({ name: "description", content: "Welcome to the site" });
  return <div>Home page</div>;
};
```

`generateMetadata({ params })` — DATA-derived, document-blocking metadata —
maps to a Meta push from the LOADER that owns the data, plus
`{ ssr: false }` for the blocking-until-in-head part:

```typescript
// Next.js: export async function generateMetadata({ params }) {
//   const product = await getProduct(params.slug);
//   return { title: product.name };
// }

// Rango: push from the loader; the flag makes the document render await it,
// so the title is in the SSR'd <head> like generateMetadata guarantees.
export const ProductLoader = createLoader(async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  ctx.use(Meta)({ title: product.name });
  return product;
});

path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader, { ssr: false }),
]);
```

Without the flag the push still applies, but a slow loader's title lands
post-hydration instead of in the document — see `/loader` → "Writing Handles
from Loaders" for the delivery race.

Add `<Html.Meta />` in the Document component's `<head>`:

```typescript
import { Html } from "@rangojs/router/client";

function Document({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <Html.Meta />
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
7. [ ] Keep inline server `fetch`/DB calls in handlers; add `createLoader()` +
       `loader()` only where you need live, refreshable, or independently
       cached data (§3)
8. [ ] Migrate `middleware.ts` to `router.use()` (auth, guards, logging)
9. [ ] Replace `next/link` with `Link` from `@rangojs/router/client`; keep
       "instant navigations" via `prefetch="viewport"`/`defaultPrefetch` (§6)
10. [ ] Convert loading/error files to `loading()` / `errorBoundary()`
11. [ ] Migrate API routes to `path.json()` / `path.text()`
12. [ ] Update metadata to use `Meta` handle + `<Html.Meta />` in document head
        (`generateMetadata` → loader push + `{ ssr: false }`)
13. [ ] Replace `next-themes` with `theme: true` in createRouter (see `/theme`)
14. [ ] Map rendering-mode segment config: `revalidate = N` → `cache({ ttl })`,
        `force-static` → `Static()`/`Prerender()`, `experimental_ppr` → the
        `ppr` path option (loader + `loading()` as the hole)
15. [ ] Run `npx rango generate src/` to generate route types
16. [ ] Verify no shims: `grep -rn "from ['\"]next" src/ app/` returns nothing,
        no mock `next/*` modules or aliases exist, and `next` is out of
        `package.json`
