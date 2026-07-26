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

## Two target shapes: server handlers or clientUrls()

Every RR route lands in one of two Rango shapes — pick per route group, not
per app (both compose in one `urls()` tree via `include()`):

- **Server handlers** (the default in this guide): the route component becomes
  a server component, data fetching merges into the handler. This is the shape
  with the biggest wins — server-first rendering, smaller client bundles — and
  the right target whenever the component CAN become a server component.

- **`clientUrls()` groups** (`/client-urls`): for route groups whose components
  are irreducibly hook-heavy client components, this is the mechanical port —
  the RR route-module shape maps almost 1:1 and nothing changes seat:

  | RR route module                  | clientUrls()                                             |
  | -------------------------------- | -------------------------------------------------------- |
  | component (client, hooks)        | stays a client component — no conversion                 |
  | `loader` (throws `redirect`/404) | `createLoader()` — thrown `redirect()`/`notFound()` kept |
  | `useLoaderData()`                | `useLoader(Loader)` at the read site, under `<Suspense>` |
  | `shouldRevalidate` (runs client) | `revalidate()` predicate — ALSO runs in the browser      |
  | `meta({ data })`                 | `ctx.use(Meta)` push from the loader body                |
  | `defer` / `Await`                | loaders stream; `<Suspense>` above each read             |

  Note the `shouldRevalidate` row: a server-tree `revalidate()` runs on the
  server, but a `clientUrls()` predicate runs in the browser with
  client-computable args — the exact RR semantics. A group ported this way can
  still be re-migrated to server handlers later, route by route.

Start with server handlers; reach for `clientUrls()` when a route group's
conversion cost is dominated by rewriting interactive components rather than
by moving data fetching — or when the group is a **high-navigation-speed
surface** (dashboard, admin panel, settings): browser-local matching gives
instant optimistic pending, and browser-run predicates hold data across
tab/param switches, so transitions are the fastest Rango offers. See
`/client-urls`.

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

| React Router import                           | Replace with                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Link`, `NavLink`                             | `Link` from `@rangojs/router/client` (`NavLink` active state via `usePathname()`, see §6)                            |
| `Outlet`                                      | `Outlet` from `@rangojs/router/client`                                                                               |
| `useNavigate`                                 | `useRouter()` from `@rangojs/router/client` (see §6)                                                                 |
| `useLocation`, `useSearchParams`, `useParams` | `usePathname()`, `useSearchParams()` (same `[params, setParams]` tuple), `useParams()` from `@rangojs/router/client` |
| `useLoaderData`                               | merge the loader into the handler; `useLoader()` for live client data or `clientUrls()` routes (see §3)              |
| `useActionData`                               | `useActionState` (standard React, see §3)                                                                            |
| `Form`                                        | `<form action={serverAction}>` with a `"use server"` function (see §3)                                               |
| `useFetcher`                                  | submits → server actions + `useActionState`/`useOptimistic`; reads → `useLoader()`                                   |
| `defer` / `Await`                             | `loading()` DSL / plain `<Suspense>` (see §5)                                                                        |
| `json()`, `redirect()`                        | plain return values; `redirect` from `@rangojs/router`                                                               |
| `useRouteError`                               | the `error` prop of `errorBoundary()` (see §5)                                                                       |

If an import has no row here and no obvious Rango equivalent, stop and surface
it to the user — do not mock it to keep the build green.

Done means: `grep -rnE "from ['\"](react-router|@remix-run)" src/ app/` returns
nothing, and the packages are out of `package.json`.

## Migration steps

Each numbered step's full walkthrough lives in a companion file linked below.

| Step                                                                                                                                           | File                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| §1 Project Setup, §2 Route Mapping                                                                                                             | [`./route-mapping.md`](./route-mapping.md)                                                             |
| §3 Data Fetching (loaders, actions, `useLoaderData`/`useActionData`, `clientLoader`/`clientAction`, `shouldRevalidate`)                        | [`./data-and-actions.md`](./data-and-actions.md)                                                       |
| §4 Middleware / Route Protection, §5 Loading & Error States, §6 Navigation, §7 Metadata / Head, §8 API / Resource Routes, §9 Theme / Dark Mode | [`./component-migration.md`](./component-migration.md)                                                 |
| §10 Cloudflare Workers (streaming, dev tooling, deploy)                                                                                        | [`../cloudflare/references/streaming-and-deploy.md`](../cloudflare/references/streaming-and-deploy.md) |

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
