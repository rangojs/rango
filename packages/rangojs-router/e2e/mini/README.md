# mini — the single-file feasibility app

A deliberately minimal `@rangojs/router` app that crams **(nearly) every feature
that fits a single app** into **essentially two hand-written source files**, to
answer one question:

> Can you build a real Rango app — loaders, actions, middleware, cache,
> intercepts, parallel routes, boundaries, location state, meta, the lot — out of
> essentially one server file and one client file?

**Answer: yes — with precise, well-understood caveats.** The two main files
(`router.tsx` + `client.tsx`) hold the bulk; the only modules RSC's
module-directive boundary forces out are `actions.tsx` and `shared.tsx`. One
extra route module (`urls/products.tsx`) is **optional** — it demonstrates
`useReverse`'s mount-aware, local-name variant; `useReverse` itself fits inline
via the auto-emitted named-routes gen (see `GlobalReverse`), so it forces no
file — though that inline form is mount-unaware (the global map's paths are
absolute), so it is only correct at the root mount. None of the splits is a
limitation of the router itself.

## File layout

Hand-written source:

| File                    | Directive      | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.tsx`        | _(server)_     | **The server file.** One `createRouter()` + one `urls()` tree, plus server-only config at the top (`createVar` tokens). All routes/layouts/`include()`/middleware/`cache()`/boundaries/`Meta` — inline.                                                                                                                                                                                                                                                                                                                |
| `src/client.tsx`        | `"use client"` | **The client file.** Every interactive component and hook in one module.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/actions.tsx`       | `"use server"` | Server actions. **Must be its own module** — a file with a top-level `"use server"` directive cannot also define the router.                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/shared.tsx`        | _(none)_       | **Only what crosses the boundary by identity:** loaders the client reads (`useLoader`/`useFetchLoader`), location-state read via `useLocationState`, and the in-memory stores those loaders share with `actions.tsx`. **Must be directive-free** — a `"use client"`/`"use server"` file can't export values the other side imports cleanly.                                                                                                                                                                            |
| `src/urls/products.tsx` | _(server)_     | An **optional** route **module** included via `include("/products", …)`: the products group (params, parallel `@cart`, intercept modal, `transition()`, the product catalog + its `ctx.use()` loader). It lives in its own file only to **demonstrate `useReverse`'s mount-aware, local-name (`.name`) variant**, whose per-module routes map is CLI-emitted. `useReverse` itself does not require this — `GlobalReverse` reverses inline against `router.named-routes.gen.ts` (see "What deliberately does not fit"). |

Config / generated (not "app code"):

- `vite.config.ts`, `package.json`, `tsconfig.json` — standard, mirror `e2e/e2e-basic`.
- `src/router.named-routes.gen.ts` — combined named-routes map; emitted by the `rango()` Vite plugin on dev/build.
- `src/urls/products.gen.ts` — per-module routes map consumed by `useReverse`; emitted by the **`rango generate` CLI** (not the dev/build plugin): `node <rango-bin> generate src/urls/products.tsx`. **Commit both gen files** alongside route changes.

So the honest shape is **2 main files + 2 RSC-mandated modules**, plus **one
optional route module (`urls/products.tsx`) that exists only to demonstrate the
mount-aware, local-name (`.name`) `useReverse` variant** (its per-module map is
CLI-emitted; `useReverse` otherwise works inline via the named-routes gen).
There is no `index.html`, no client entry, and no server entry — the Vite plugin
injects the browser/SSR/RSC entries automatically.

## Why the two extra modules are unavoidable

This is the load-bearing finding. It is an RSC module-boundary rule:

- **`"use server"` is module-level.** React serializes actions from a module
  whose first statement is `"use server"`. `createRouter()` can't live in such a
  file, so module-level actions need their own file. (Inline `"use server"`
  closures inside a server component _can_ live in `router.tsx`, but then they're
  passed as props rather than imported by `client.tsx`.)
- **Only _client-referenced_ definitions can't sit in a directive file.** A
  `createLoader()` / `createLocationState()` value the **client** reads by
  identity (`useLoader`, `useLocationState`) can't live in `client.tsx` (the
  server would get a `$$id`-only stub with no runnable fn) nor in `router.tsx`
  (the client would pull the router factory into its graph and throw at
  module-eval). A directive-free `shared.tsx` is the resolution.
  (`@rangojs/router`'s root entry exports these as client-safe stubs, so
  importing `shared.tsx` from either side is fine.)
- **Server-only definitions need no separate module.** The `urls()` patterns
  (inherently server-only) and `createVar` tokens (read only in
  middleware/handlers) aren't imported by the client, so they stay in
  `router.tsx`. The split maps to the boundary: `shared.tsx` is precisely the set
  of definitions the client touches by identity. (The products module is not
  required by any of these rules — it is an optional demonstration of the
  mount-aware local `useReverse` variant; see below.)

## Features exercised (all asserted in dev **and** production — see `../mini.test.ts`)

Routing & structure: `urls`/`path`/`layout`, nested `include()`, route params,
typed `search` schema, `Outlet`/`ParallelOutlet`, named slots.
Data: `loader()` + `useLoader`, fetchable loader + `useFetchLoader`,
`useRefreshLoaders` (refresh group), `ctx.use(Loader)`.
Mutation: `"use server"` actions via `useActionState`, imperative + `useAction`,
`revalidate(ctx.isAction(...))`.
Middleware: global `.use()` (header + `ctx.set` var) and route-level
`middleware()` on a subtree.
Caching: segment `cache({ ttl, swr })`, `"use cache: <profile>"` with
`cacheProfiles`, loaders staying fresh inside a cached segment, and the
shell-manifest pattern on `/manifest` — the cached shell pushes its rendered
ids into a handle, replay-on-hit feeds the live `ManifestPricesLoader`
(`ctx.rendered()`), so prices stay fresh under a frozen shell (see the
`/shell-manifest` skill).
Control flow: `errorBoundary()`, `notFoundBoundary()` (thrown
`DataNotFoundError`), `redirect()`, global `notFound`.
Streaming/UX: parallel slot with its own loader + `loading()`, `intercept()`
modal gated by the `when` config, `transition()` content-hold (component state survives a
same-route param change).
State & nav: `createLocationState` (flash + persistent), `useLocationState`,
`Link state`, `useRouter`/`useNavigation`/`usePathname`/`useSegments`/`useParams`/
`useSearchParams`, `useLinkStatus`, `ScrollRestoration`.
Links: `Link`, `href`, `ctx.reverse`, mount-aware `useMount`/`useHref`,
`useReverse` two ways — mount-aware local names via the `urls/products.tsx`
per-module gen (`ProductsReverse`), and dotted global names via the inline
`router.named-routes.gen.ts` (`GlobalReverse`, root mount only).
Head: `Meta` (title template) + `Breadcrumbs` + `useHandle`, `MetaTags` via the
default document.

## What deliberately does **not** fit the single-file shape

- **`useReverse`'s mount-aware local (`.name`) variant needs a per-module route
  module.** That form imports a per-module `urls/*.gen.ts`, emitted by the
  `rango generate` CLI (not the dev/build plugin), which only exists for a route
  group in its **own** `urls/*.tsx` file — so the products group was extracted
  into `urls/products.tsx` to exercise it (`ProductsReverse`). `useReverse`
  itself is **not** stuck behind that file: an inline `include()` group is
  reversible on the client via the auto-emitted `router.named-routes.gen.ts`
  using full dotted global names (`GlobalReverse` does exactly this with
  `.products.detail`). The caveat: `useReverse` always mount-prefixes and the
  global map's paths are absolute, so the global form is mount-unaware — correct
  at the root mount, double-prefixing under a non-root mount. (This asymmetry
  with `ctx.reverse`/`scopedReverse`, which accept non-dotted absolute global
  names, is a known gap.) `Link`, `href`, `ctx.reverse`, `useHref`, `useMount`,
  `useLinkStatus` all work inline with no extra module.
- **Host router (`createHostRouter`).** A different top-level entry that mounts
  sub-apps; it is a composition layer _above_ an app, not a feature _of_ one.
- **Build-time prerender (`Prerender`/`Static`).** Works in a single file but
  needs build config (`buildEnv`, often a Cloudflare/wrangler runtime) to be
  meaningful, so it is out of scope for this vanilla-Vite demo.
- **Theme, response/MIME routes, SSE/WebSocket routes, telemetry, timeouts.**
  All fit a single app trivially (router options or extra `path.*()` leaves) but
  were scoped out to keep the demo focused; none would add a file.

## Gotchas worth knowing

- **`createLoader`/`createHandle`/`createLocationState` must be `export`ed** —
  even a server-only loader used only via `ctx.use()` in the same file. The
  `exposeInternalIds` Vite transform injects the stable `$$id` from the
  `export const X = ...` declaration, so a bare (non-exported) `createLoader()`
  fails route discovery with "Loader is missing $$id". `createVar` tokens are
  the exception: they are not `$$id`-injected (matched by object identity), so
  they need no export.
- **Source scanners are comment/string-aware.** The router-file scanner
  (`findRouterFiles`), the HMR relevance check, and the unsupported-shape warning
  all strip comments and string literals before matching, so a `createRouter(` /
  `createLoader(` token written in a comment or string no longer produces a
  spurious "Multiple routers found" error or "Unsupported shape" warning. (This
  was previously a footgun — both `actions.tsx` and `shared.tsx` here mention
  these tokens in comments freely.)
- **Named cache profiles are applied via the `"use cache: <profile>"` directive.**
  There is no `cache("name", …)` form in the route tree (the string overload was
  removed); in-tree segment caching uses explicit `cache({ ttl, swr }, …)`.
- **`useRefreshLoaders` group refresh re-fetches via the GET loader endpoint**,
  so grouped loaders must be **fetchable** (`createLoader(fn, true)`) or the
  refetch rejects into an unhandled error.

## Run it

```sh
# from packages/rangojs-router/e2e/mini
pnpm dev        # http://localhost:<port>
pnpm build && pnpm preview

# e2e (from packages/rangojs-router) — dev + production
pnpm exec playwright test mini.test.ts --project=dev --project=production --no-deps
```
