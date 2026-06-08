# Dogfooding `@rangojs/router/testing` on cloudflare-basic — findings

This suite is the pilot for adding a unit/integration/DOM/RSC test layer (the new
`@rangojs/router/testing*` surface from PR #533) to a **real** consumer app. The
goals: prove the infra is applicable to our test apps, and catch bugs in both the
infra and the app. This file records what we hit.

Status: all 4 entries are exercised and green here —
`runLoader`/`runMiddleware`/`dispatch` (unit + integration), `renderRoute`
(`/dom`), `renderToFlightString` (`/flight`), plus the `cache-status` and
`generated-routes` helpers. 31 tests (`pnpm test:unit` + `pnpm test:unit:rsc`).

**Most findings below were FIXED in the same change** (see "Resolution" tags):
the setup is now a one-line preset (`@rangojs/router/testing/vitest` →
`rangoTestAliases`), and all four type-ergonomics issues were fixed in the
package, so this suite uses the preset and needs **no casts**. The remaining open
items are inherent limitations (full-router import; flight ctx) documented below.

## What the docs say vs. what a real Cloudflare consumer actually needs

> **Resolution:** the manual setup below is now packaged as the
> `@rangojs/router/testing/vitest` preset — `vitest.config.ts` here is just
> `resolve: { alias: rangoTestAliases({ preset: "cloudflare" }) }`. The notes below
> explain what that preset does and why.

The docs' setup for `dispatch` is "`vi.mock('@vitejs/plugin-rsc/rsc')` then
`import { router } from '../src/router'`". That is **not sufficient** for a real
app. The working setup (now the preset) is:

1. **Alias the bare `@rangojs/router` specifier to its react-server entry**
   (`src/index.rsc.ts`) — exact-match regex so subpaths (`/testing`, `/client`)
   are untouched. Without this, `urls()`, `createRouter()`, `redirect()`,
   `cookies()`, `getRequestContext()` resolve to **server-only stubs that throw**
   ("only available … in a react-server/RSC environment"), so importing the app's
   own router/loaders/middleware fails immediately. Keeping React as the _client_
   build (no `react-server` condition) means `createContext` and `"use client"`
   modules still work.
2. **Stub the Cloudflare runtime virtuals** `cloudflare:workers` /
   `cloudflare:email` — the route tree imports them
   (`pages/build-env-direct-handler.tsx`, durable objects). The docs only mention
   `@vitejs/plugin-rsc/rsc`.
3. **Alias the build-only `@rangojs/router:version` virtual** to a stub.
4. **Stub `@vitejs/plugin-rsc/rsc`** (we alias it instead of per-file `vi.mock`).
5. A separate `vitest.rsc.config.ts` for Flight (the `react-server` condition +
   `--conditions=react-server` worker flag), as documented.

## Infra findings (would benefit from a fix in the testing package)

1. **The documented `dispatch` recipe does not work against a real consumer
   router.** Root causes, in the order a consumer hits them:
   - `@rangojs/router` resolves to server-only **stubs** outside the
     `react-server` condition (urls/createRouter/redirect/cookies/getRequestContext
     all throw). The PR's own `dispatch.test.ts` dodges this by importing the
     _internal_ `urls-function.js` / `router.js`; a consumer importing the public
     barrel cannot.
   - The `react-server` **condition is not applied to bare-package exports
     resolution by Vitest** — neither `resolve.conditions: ['react-server']` nor
     running under the rsc project flips `@rangojs/router` to `index.rsc.ts`. Only
     an explicit alias (or `ssr.resolve.conditions`, which then also flips React)
     does. This is why no existing test exercises the package's own react-server
     export map.
   - Handler `$$id` is NO LONGER the blocker: `Prerender()` / `createLoader()` /
     `Static()` each assign a process-stable runtime fallback id in a bare test,
     so they construct without "missing `$$id`". But the **full** app router
     _file_ still can't be imported in bare vitest — its page modules pull
     app-specific deps and/or plugin `virtual:` modules that need the rango
     plugin (an import of `src/router.tsx` fails on a page dep before any rango
     concern). So `dispatch` / `generated-routes` / `cache-status` against the
     _whole_ router require the rango plugin or e2e.
     **Workaround used here:** build a router from an importable, focused include
     (the app's real `apiPatterns`) — this tests real handlers and works with
     just the aliases.

   **Recommendation:** ship a one-line vitest preset from the testing package
   (e.g. `@rangojs/router/testing/vitest`) that wires the alias + virtual stubs +
   plugin-rsc stub, and/or a documented "rango plugin in test mode" so the full
   router can be imported. Update `docs/testing.md` + the `/testing` skill to show
   the real consumer setup (the alias, the CF stubs, the full-router limitation).

2. **Flight: a consumer server component that imports a server API from the
   `@rangojs/router` barrel cannot be flight-tested.** `getRequestContext` /
   `cookies` resolve to the throwing stub even under the rsc project; aliasing to
   the real entry then fails on the router's `virtual:` imports. Only **pure leaf**
   server components (no `@rangojs/router` imports) render — which matches the
   documented v1 scope, but the docs' `getRequestContext` Flight example would not
   work for a consumer.

## Type-ergonomics findings (consumer API surface) — ALL FIXED this change

3. **`dispatch(router)` does not typecheck against the public router type.**
   `DispatchableRouter` required `middleware` / `findMatch` / `previewMatch`, which
   the public `Rango<…>` type does not surface, so a real router needed a cast (the
   PR's own test used `as any`).
   **Resolution:** `dispatch` now takes `Rango<TEnv, any>` and reads the internals
   through the dispatchable shape — no consumer cast.

4. **`runLoader`/`runMiddleware` `vars` tuples don't infer.** `vars: [["user", v]]`
   inferred as `string[][]`, not `[key, value][]`.
   **Resolution:** `vars` now accepts a `Record<string, unknown>` (the ergonomic
   `{ user: v }` form) OR a `[key, value]` tuple list, both inferring cleanly.

5. **`RunMiddlewareResult.ctx` union lacks `.cookies()`.** It was typed
   `RequestContext | MiddlewareContext`; only the former has `cookies()`.
   **Resolution:** `ctx` is now typed as the `RequestContext` the chain ran under,
   so `ctx.cookies()` works with no cast.

6. **`runLoader` context typing ignored the test options.** `ctx.reverse` was bound
   to the _global_ registered route names, and `ctx.get` to declared `Rango.Vars`
   keys/ContextVars, so a `routeMap`-only name or an ad-hoc `vars` key was a type
   error though it resolved at runtime.
   **Resolution:** the runLoader body now sees a `TestLoaderContext` that relaxes
   `reverse` (any `routeMap` name) and `get` (any string key/ContextVar).

## DX note

7. **Naming collision:** `ctx.cookies()` on the returned RequestContext is a
   `Record<string,string>` (property access), while the global `cookies()` is a
   jar with `.get()`/`.set()`. Easy to conflate; worth a docs callout.

## What works cleanly (no workarounds beyond the setup above)

- `runLoader` against exported raw loader bodies — including bodies that call
  `cookies()` (real cookie parsing through a real RequestContext). Required
  exporting the loader body (the documented pattern); see
  `src/loaders/cookie-overlay.ts`.
- `runMiddleware` against exported middleware fns — real `executeMiddleware`,
  short-circuit, Set-Cookie merge, ordering. Required extracting the inline route
  middleware to an export; see `src/middleware/cookie-overlay.ts`.
- `dispatch` against an importable, focused response-route router (real
  handlers): bare JSON value, params, thrown `RouterError` → 404 RFC 9457
  problem+json, 404.
- `renderRoute` against real `"use client"` components (useParams / useReverse /
  Link / client navigate()).
- `renderToFlightString` against pure leaf server components (real Flight wire +
  `toMatchFlight` / snapshot).
- `parseCacheHeader` / `assertCacheStatus` (header form) / `createCacheSink` /
  `filterCacheDecisions` / `diffGeneratedRoutes` / `assertGeneratedRoutesMatch`.

## App changes made to enable testability (the documented pattern)

- `src/loaders/cookie-overlay.ts`: export the loader **body** separately so
  `runLoader` can take the raw fn.
- `src/middleware/cookie-overlay.ts`: extract the inline cookie middleware to an
  exported fn so `runMiddleware` can drive it (and `urls.tsx` references it).

## Coverage gaps to close at the e2e layer (by design)

- End-to-end cache hit/miss/stale/prerendered assertions (`assertCacheStatus` on a
  real response) need the running app with `debugCacheSignal` on — `dispatch` does
  not emit cache decisions and the full router can't be imported here.
- Whole-app generated-route drift (`assertGeneratedRoutesMatch(fullRouter, …)`)
  needs importing the full router file. For cloudflare-basic that file still
  can't be bare-imported (app page-module deps / plugin `virtual:` modules — NOT
  handler `$$id`, which now falls back), but for an app whose router file IS
  bare-importable the primitive force-expands lazy `include()`s and does the
  whole-app check in a unit test (see the mini app). renderRoute also now seeds `useLoader`/`useLocationState`/
  `useHandle` by reference (the `loaders`/`locationState`/`handles` options).
