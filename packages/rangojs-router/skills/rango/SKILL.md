---
name: rango
description: Overview of @rangojs/router and available skills
argument-hint:
---

# @rangojs/router

Django-inspired RSC router with composable URL patterns, type-safe href, and server components.

This page is the mental model to read **before** the catalog. A flat list of
skills gives nothing to slot details into, so a reader free-associates from local
vocabulary — which is exactly how `revalidate()` gets misread as caching. Start
with the shape, then pick a primitive.

## The shape of rango (read first)

- **Routes are expressed, not configured.** The `urls()` tree shows where every
  route, layout, loader, and cache lives. No file-system convention, no hunting.
- **Two freshness axes, orthogonal:**
  - _stored-value freshness_ — `"use cache"`, `cache()`, loader `cache()`
    (SWR is first-class where the store supports it; `"use cache"` ships a
    default SWR window; see `/cache-guide`)
  - _client-update selection_ — `revalidate()`
- **Loaders are the live data layer** — fresh every request by default, even
  inside a cached render. They run **in parallel** right after middleware and
  **stream**, so data latency overlaps first paint instead of blocking it (a
  cache hit streams UI instantly while loaders resolve fresh alongside). Opt into
  caching explicitly. See `/loader` → "Parallel and streaming".
- **One identity, one store** — loaders, handles, cached fns, and actions are all
  `path#export`; all caches share one store. Entries expire by TTL/SWR, and are
  tagged via `cache({ tags })` or runtime `cacheTag(...tags)`; built-in stores
  index by tag and invalidate via `updateTag(...tags)` (awaitable, read-your-own-writes)
  or `revalidateTag(...tags)` (background, non-blocking).
- **Type-safe end to end** — route names, params, search schemas, loader return
  types, context vars, and `href` / `reverse` are checked at compile time
  (`/typesafety`).
- **See where time goes** — turn on `debugPerformance` early (router option, or
  `ctx.debugPerformance()` in middleware for per-request opt-in). It prints a
  per-request waterfall + `Server-Timing` header; loaders should overlap the
  render bar, not serialize after it. For production, wire `telemetry` to a
  console, OpenTelemetry, or custom sink. See `/observability`.

Most features are **just-in-time**: the core is `urls()`, `path()`, `layout()`,
`include()`, and `reverse()`. Caching, parallel routes, intercepts, prerender,
i18n, themes, and the rest are opt-in — reach for them when a requirement
appears, not up front.

## Composability: structure vs config

- `path()` / `include()` are **structure** — they define URLs and must stay
  visible in `urls()`. They cannot be hidden in a factory. `include()` composes
  whole modules (separation of real concerns); `path()` places a leaf.
- Everything else — `cache`, `loader`, `loading`, `middleware`, `revalidate`,
  `parallel`, `intercept`, `errorBoundary`, … — is **config**. It attaches to a
  node via its `use` callback, is importable, and extracts into factories that
  return arrays (`withAuth()`, `withCaching()`), flattened automatically.

To decide where something can live: **does it define a URL? structure, stays in
`urls()`. Does it modify a node? config, compose freely.**

## Pick a primitive

| I need to…                            | Use                              | Skill                   |
| ------------------------------------- | -------------------------------- | ----------------------- |
| render data fresh every request       | `loader()` + `useLoader()`       | /loader                 |
| cache a rendered subtree              | `cache()` on a segment           | /caching                |
| cache one function/component's result | `"use cache"`                    | /use-cache              |
| cache a loader's data                 | `loader(L, () => [cache()])`     | /loader, /caching       |
| re-render a segment after an action   | `revalidate()`                   | /loader                 |
| mutate                                | `"use server"` action            | /server-actions         |
| debug a slow request                  | `debugPerformance` / telemetry   | /observability          |
| share config across routes            | factory returning a helper array | /composability          |
| compose a sub-app / module            | `include()`                      | /route                  |
| modal / soft navigation               | `intercept()`                    | /intercept              |
| pre-render a route at build time      | `Prerender(...)` wrapper         | /prerender              |
| stream SSE / upgrade a WebSocket      | `path.stream()` / `path.any()`   | /streams-and-websockets |

## Invariants

- `path()`/`include()` are always visible in `urls()`; config helpers are extractable.
- **Cache decides freshness; `revalidate()` decides client-update.** Orthogonal; compose.
- Loaders resolve fresh every request (even inside `cache()`) and never run twice/request.
- Inside `"use cache"`: `cookies()`/`headers()` and `ctx` side-effects
  (`set`/`header`/`setTheme`/`onResponse`/`setLocationState`) throw; `ctx.use(Handle)`
  is captured on miss and replayed on hit. (The non-cacheable read guard is a
  separate `cache()`-boundary check — see the correctness bullet below.)
- One identity `path#export` (`functionId`/`$$id`/`actionId`); one store. Freshness
  is TTL/SWR expiry plus tag-based invalidation: tag via `cache({ tags })` /
  `cacheTag(...tags)`, then `updateTag(...tags)` (awaitable) or `revalidateTag(...tags)`
  (background). Built-in stores index by tag.
- `useLoader` / `useHandle` / `useFetchLoader` are client-only.
- Caches are correctness-first: persistent store keys are version-segmented (no
  cross-deploy drift), the forward/back cache is mutation-aware, and
  `createVar({ cache: false })` throws on a **direct** read inside a `cache()`
  boundary (a deliberately non-propagating guard). See `/cache-guide` →
  "Correctness & invalidation".
- Nested caches: the outer cache window bounds the inner — an inner shorter TTL
  only applies when the enclosing cache recomputes; put a value in a loader if it
  must be fresher. See `/cache-guide` → "Combining Both".

## Don't confuse

- `revalidate()` ≠ cache invalidation — partial-render selection vs value freshness.
- host router `.lazy()` (lazy import of a handler/sub-app) vs `.map()` (inline Response).
- `cache()` (segment, in the DSL) vs `"use cache"` (function/component directive).
- `loader()` registration (server) vs `useLoader()` consumption (client).

### Coming from another framework (false friends)

Same words, different jobs — this is the most common source of the
`revalidate()`-is-caching misread.

| You may know                            | Maps to Rango axis | Watch out                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js `export const revalidate = N`   | **Axis 1** (cache) | Same word, opposite meaning. Next's `revalidate` is time-based cache expiry; Rango's `revalidate()` is **axis 2**. Use `cache({ ttl })` for the Next behavior.                                                                                                                          |
| Next.js `revalidateTag` / `updateTag`   | **Axis 1** (cache) | Cache busting by tag. Tag via `cache({ tags })` / `cacheTag(...tags)`; invalidate with `updateTag(...tags)` (awaitable, read-your-own-writes) or `revalidateTag(...tags)` (background, non-blocking). Built-in stores index by tag. No `revalidatePath` (path-based busting); use tags. |
| React Router / Remix `shouldRevalidate` | **Axis 2**         | This is the correct mental model for Rango's `revalidate()`.                                                                                                                                                                                                                            |
| HTTP `Cache-Control` / ISR              | **Axis 1**         | Edge/document layer — see `/document-cache`. Separate from both `cache()` and `revalidate()`.                                                                                                                                                                                           |
| Remix/RR `loader`                       | live data          | Like Rango loaders, fresh per request — but Rango loaders run in parallel and stream (latency overlaps first paint), and can opt into caching on demand.                                                                                                                                |

See `/cache-guide` for the axis-1 decision guide, `/loader` and `/route` for
`revalidate()` (axis 2), and `/document-cache` for the edge layer.

## Canonical shape

```ts
export const urlpatterns = urls(({ path, layout, loader, loading, cache, revalidate }) => [
  layout(<ShopLayout />, () => [                 // structure: wraps children
    loader(CartLoader, () => [                   // config: live data
      // partial-render axis: re-run on cart actions, defer otherwise.
      // ctx.isAction() matches by reference (rename-safe), not by string.
      revalidate((ctx) => ctx.isAction(CartActions) || undefined),
    ]),
    path("/shop/:slug", ProductPage, { name: "product" }, () => [  // structure: leaf
      loader(ProductLoader, () => [cache({ ttl: 60 })]),  // config: cache loader DATA
      loading(<ProductSkeleton />),              // config
      withRecs(),                                // composed factory (config array)
    ]),
  ]),
]);
```

One tree, both axes visible: structure (`layout`/`path`) vs config (everything
else), freshness (`cache`) vs client-update (`revalidate`). Actions are matched
by reference with `ctx.isAction(Action)` (rename-safe, where `CartActions` is an
`import * as CartActions from "./actions/cart"`); see `/typesafety` → "Stable
identity".

The predicate arg carries the action's full context, not just its identity. Match
_which_ action with `ctx.isAction(addToCart)` (rename-safe); branch on _what it
returned_ with `ctx.actionResult` — the value your `"use server"` function
returned, for outcome-conditional revalidation. The arg also exposes `actionId`
(raw `path#export`), `actionUrl`, `formData`, `method`, and `stale` (cross-tab
`_rsc_stale` signal). All are `undefined` on plain navigation (no action).

```ts
// re-render only when checkout actually succeeded; defer otherwise
revalidate((ctx) => (ctx.isAction(checkout) && ctx.actionResult?.ok) || undefined),
```

**The source is the source of truth.** Structure, types, and update policy are
visible and local in the tree — read top-down, no hidden global model to hold in
your head. A snippet earns its place only if, from the code alone, you can answer:
_what URLs exist and who owns them?_ (composition), _can I trust this reference
without leaving the call site?_ (type-safety), _what re-renders after this
action?_ (partial rendering). If any answer needs another file, it isn't legible
yet.

**Reading Rango's own source.** Rango is consumed as raw TypeScript — the
`exports` map resolves `@rangojs/router` and its subpaths to `./src/*.ts` for
both types and runtime, so a consuming app bundles Rango straight from source.
Only the `./vite` plugin entry and the CLI `bin` load from `dist/`. To confirm
any runtime or type detail against an installed copy, read the resolved source
under `node_modules/@rangojs/router/src/`, not `dist/` — the runtime does not
resolve `dist/` outside `./vite`, and it may lag `src/`.

## Skills

Grouped by concern — read when you need to…

**Structure & routing** — shape URLs, layouts, navigation, and request processing:

| Skill                     | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `/router-setup`           | Create and configure the RSC router                                        |
| `/route`                  | Define routes with `urls()`, `path()`, and `include()`                     |
| `/layout`                 | Layouts that wrap child routes                                             |
| `/parallel`               | Multi-column layouts and sidebars                                          |
| `/intercept`              | Modal/slide-over patterns for soft navigation                              |
| `/middleware`             | Request processing and authentication                                      |
| `/host-router`            | Multi-app host routing with domain/subdomain patterns                      |
| `/links`                  | URL generation: ctx.reverse, href, useHref, useMount, scopedReverse        |
| `/response-routes`        | JSON/text/HTML/XML/stream endpoints with `path.json()`, `path.text()`      |
| `/api-client`             | Typed client for consuming your own response-route JSON APIs (recipe)      |
| `/mime-routes`            | Content negotiation — same URL, different response types via Accept header |
| `/streams-and-websockets` | SSE via `path.stream` and WebSocket upgrades via `path.any`                |
| `/handler-use`            | Attach default loaders/middleware to a handler via `handler.use`           |
| `/composability`          | Reusable route-helper factories (structure vs config)                      |

**Data & caching** — fetch, mutate, and cache:

| Skill             | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `/loader`         | Data loaders with `createLoader()` and `revalidate()`                   |
| `/server-actions` | Mutations with `"use server"`, useActionState, validation, revalidation |
| `/caching`        | Segment caching with memory or KV stores                                |
| `/use-cache`      | Function-level caching with `"use cache"` directive                     |
| `/cache-guide`    | When to use `cache()` vs `"use cache"` — differences and decision guide |
| `/document-cache` | Edge caching with Cache-Control headers                                 |
| `/prerender`      | Pre-render route segments at build time (Passthrough live fallback)     |

**Client & presentation** — build the client-side UX:

| Skill               | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `/hooks`            | Client-side React hooks                                                   |
| `/theme`            | Light/dark mode with FOUC prevention                                      |
| `/i18n`             | Locale routing with `:locale?`, resolution chains, react-intl integration |
| `/fonts`            | Load web fonts with preload hints                                         |
| `/css`              | Import CSS in the Document `<head>` (`?url` + managed `precedence` links) |
| `/tailwind`         | Set up Tailwind CSS v4 with `?url` imports                                |
| `/view-transitions` | React View Transitions on layouts, routes, and parallel slots             |
| `/breadcrumbs`      | Built-in Breadcrumbs handle for breadcrumb navigation                     |
| `/react-compiler`   | Enable React Compiler (opt-in) the vite-rsc way; client-only scope        |

**Observability & production health**:

| Skill              | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `/observability`   | `debugPerformance`, `Server-Timing`, structured telemetry, tracing       |
| `/bundle-analysis` | Audit your app's production bundle for server leaks and oversized chunks |
| `/debug-manifest`  | Inspect route manifest structure                                         |

**Setup, types & migration**:

| Skill                   | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `/typesafety`           | Type-safe routes, params, href, and environment |
| `/migrate-nextjs`       | Migrate a Next.js App Router project to Rango   |
| `/migrate-react-router` | Migrate a React Router / Remix project to Rango |

## Quick Start

```typescript
// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
]);

// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

export default createRouter({ document: Document }).routes(urlpatterns);
```

Use `/typesafety` for type-safe href and environment setup.

## CLI: `npx rango generate`

Single command to generate `.gen.ts` route type files. Auto-detects file type and
generates the appropriate output.

```bash
# Single file
npx rango generate src/urls.tsx

# Multiple files
npx rango generate src/router.tsx src/urls.tsx

# Directory (recursive scan)
npx rango generate src/

# Mix of files and directories
npx rango generate src/urls.tsx src/api/
```

### Auto-detection

Each file is classified by its contents:

| Contains       | Generated output                                                 |
| -------------- | ---------------------------------------------------------------- |
| `urls(`        | Per-module `*.gen.ts` with route names, patterns, params, search |
| `createRouter` | Per-router `*.named-routes.gen.ts` with global route map         |
| Both           | Both files                                                       |

Directories are scanned recursively for `.ts`/`.tsx` files, skipping `node_modules`,
dotfiles, and existing `.gen.` files.

> The two generated files are **not interchangeable surfaces**.
> `router.named-routes.gen.ts` augments the global `GeneratedRouteMap` for
> named-route typing (`Handler<"name">`, `ctx.reverse("name")`, prerender).
> Per-module `*.gen.ts` exports a local `routes` map for `useReverse(routes)`
> and explicit local handler typing (`Handler<".name", routes>`). Neither
> carries response payloads — response/MIME payload inference comes from
> `typeof router.routeMap` via `RegisteredRoutes`, not `*.named-routes.gen.ts`.
> See `/typesafety` for the full surface breakdown.

### Recursive includes

The generator follows `include()` calls across files, resolving imports to build
the full route tree. Circular includes are detected and warned about.

### First-wins deduplication

When a route name appears more than once, the first definition wins and duplicates
are dropped with a warning. This applies only to the generated `.gen.ts` type files.
Define the primary route before any fallback variant that reuses the same name.

Content negotiation (see `/mime-routes`) is unaffected — negotiated routes use
distinct names (e.g. `"product"` and `"productJson"`) and the Accept header
dispatching happens at runtime in the trie, not in the type generator.

### Limitations

The CLI uses static source analysis (AST walking), not runtime execution. It cannot
extract routes defined dynamically:

- `Array.from()` or `.map()` generating path() calls
- Conditional routes behind `import.meta.env` or feature flags
- Routes computed from external data (databases, config files)
- Template literal patterns with interpolated variables

These routes are only discovered by the Vite plugin's runtime discovery during
`pnpm dev` or `pnpm build`. The CLI-generated `.gen.ts` may have fewer routes
than the runtime-generated version. During dev, the `preserveIfLarger` guard
prevents the static parser from overwriting a larger runtime-discovered file.
