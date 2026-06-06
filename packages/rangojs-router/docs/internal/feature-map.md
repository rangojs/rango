# Rango Feature Map (Internal)

Package: `@rangojs/router`

> **Internal implementation map.** This documents all capabilities including
> internal-only APIs. It is not a public API reference. For the public contract,
> see the actual export surfaces in `package.json` and source entrypoints.

Related docs:

- [Execution model](./execution-model.md) — runtime contract, middleware scope, revalidation guarantees
- [Feature-to-file map](./feature-file-map.md) — source ownership for each feature
- [Semantic change checklist](./semantic-change-checklist.md) — PR checklist for contract changes

---

## Export Surface

### Public

| Export                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                         | Root entrypoint with shared types/utilities plus server/RSC APIs selected via the `react-server` export condition: `createRouter`, `createLoader`, `redirect`, `cookies()`, `headers()`, route DSL, errors, helpers, URL/route utilities, reverse lookup. Default (non-RSC) entry also exports universal handles `Meta` and `Breadcrumbs` alongside `createHandle`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `./client`                  | Client-side components and hooks (see [Client API](#client-api) below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `./vite`                    | Public Vite plugin surface: `rango()`, `poke()`, and plugin option types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `./browser`                 | Browser bootstrap: `initBrowserApp`, `Rango`, `InitBrowserAppOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `./rsc`                     | Advanced server request-pipeline APIs: `createRSCHandler`, request-context access, RSC handler types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `./ssr`                     | Advanced HTML rendering bridge: `createSSRHandler`, nonce/form-state/streamMode support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `./build`                   | Manifest and route-type generators: `generateManifest`, `generateManifestFull`, `generateManifestCode`, `writePerModuleRouteTypes`, `generatePerModuleTypesSource`, `extractRoutesFromSource`, `buildRouteTrie`, `createScanFilter`, `hashParams`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `./cache`                   | Segment and response cache APIs: `SegmentCacheStore`, `MemorySegmentCacheStore`, `CFCacheStore` (L1 + optional KV L2), `KVNamespace`, document cache middleware, cache scope utilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `./theme`                   | Theming public API: `useTheme`, `ThemeProvider`, `ThemeScript`, theme constants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `./host`                    | Host-based multi-app routing: `createHostRouter`, `defineHosts`, host matching types. Route builder splits intent: `.map((request) => Response)` (inline handler) vs `.lazy(() => import("./sub-app"))` (lazy mount)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `./host/testing`            | Host router test helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `./testing`                 | Consumer unit + integration primitives (Vite-driven Vitest): unit (`runMiddleware`, `runLoader`), integration (`dispatch`), cache/prerender signals (`assertCacheStatus`, `parseCacheHeader`, `createCacheSink`, `filterCacheDecisions`), generated-route drift (`diffGeneratedRoutes`, `assertGeneratedRoutesMatch`), handle collect (`collectHandle`), advanced context (`runInRequestContext`, `runWithRequestContext`, `createTestRequestContext`, `toRequest`, `seedVariables`). Never references React, `@testing-library/react`, `@playwright/test`, or the RSC runtime — those live at the entries below. Pulls the router-manifest virtuals, so it needs the rango Vite plugin (or a `@rangojs/router:version` alias).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `./testing/vitest`          | Vitest setup helper. `rangoTestConfig({ preset? })` -> the `test`-block fragment `{ alias, server: { deps: { inline } } }` (recommended; spread into `test`); `rangoTestAliases({ preset? })` -> just the `resolve.alias` entries (`preset: "node" \| "cloudflare"`, default `"node"`, mirrors `rango({ preset })`; `"cloudflare"` also stubs the CF runtime virtuals); `rangoInlineDeps` -> the `server.deps.inline` patterns; `rangoUseClientTransform()` -> a Vite plugin for the FLIGHT (`react-server`) vitest project that applies the `"use client"` transform (lazy-imports `@vitejs/plugin-rsc/transforms` + vite's `parseAstAsync`), so `renderServerTree` auto-discovers client islands from a server tree's own imports (no `clientComponents`); server components without the directive are untouched. Aliases bare `@rangojs/router` to its react-server entry (real impls, client React kept) and stubs the `@rangojs/router:version` / `@vitejs/plugin-rsc/rsc` (and optionally `cloudflare:workers`/`cloudflare:email`) virtuals. `deps.inline` is required for an installed consumer (rango ships TS source; Node >= 23 won't type-strip `.ts` under node_modules). UNLIKE every other entry, this one SHIPS AS COMPILED JS (`dist/testing/vitest.js`, built by `pnpm build`) because a `vitest.config.ts` is loaded directly by Node — same reason `./vite` is compiled. Imports just `node:url`; alias targets are anchored at the package root so they resolve to `src/*.ts` from both the source and `dist` layouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `./testing/dom`             | Component-render testing: `renderRoute` (RTL-style client-tree stub) + its types. Separate so the `./testing` barrel never references React/`@testing-library/react`; `renderRoute` lazy-loads `@testing-library/react` at call time. Run in a DOM env (happy-dom/jsdom).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `./testing/e2e`             | Playwright harness factory `createRangoE2E({ test, expect })` -> `useFixture`, `parityDescribe`, `expectParity`, page helpers (`waitForHydration`, `expectNoReload`, …), `testNoJs`, `rangoMatchers` (`toHaveRangoPathname` + type augmentation). Also re-exports the pure cache-status helpers (`assertCacheStatus`, `parseCacheHeader`, `createCacheSink`, `filterCacheDecisions`) so they are usable in a Playwright e2e — the `./testing` barrel can't be imported in a plain Playwright runner (it pulls the build-only `@rangojs/router:version` virtual). Separate so it loads in a plain (non-Vite) Playwright runner; takes the consumer's `test`/`expect`, never importing `@playwright/test` at runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `./testing/flight`          | Real Flight (RSC) rendering, `react-server` condition only: `renderToFlightString` (wire string), `normalizeFlight`, `assertFlightRuntimeAvailable`; plus `renderServerTree` (serialize -> deserialize to an inspectable React element tree) with `findClientBoundaries(tree, name?)` (always an array; destructure for the first) and `assertFlightTreeRuntimeAvailable`. `renderServerTree`/`renderToFlightString` render an ELEMENT and accept a `vars` seed (plus `headers`/`params`/`env`) so a server component reading `getRequestContext()`/`cookies()`/`ctx.get(var)` DURING render is testable. `renderHandler(handler, opts)` runs a REAL route handler — the pure function `(ctx) => rsc` you pass to `path(...)` — with the router's real `HandlerContext` (`createHandlerContext` + an overridden `ctx.use`: loaders SEEDED by reference like `runLoader`, handles return a recording push fn), then serializes its RSC to an inspectable tree; returns `{ tree, flight, thrown, response, cookies, headers, locationState, handles }` (the render counterpart to `runInRequestContext` — same effect snapshot PLUS the rendered RSC; a `throw redirect()` is captured on `thrown` with `tree` undefined; an unseeded loader rejects). `seedVariables`/`VarsInit` live in the react-server-safe `testing/internal/seed-vars.ts`; `serializeNodeToFlight` (flight.ts) + `deserializeFlight`/`makeClientManifest`/`registerClientComponents` (flight-tree.ts) are the shared serialize/deserialize core renderHandler reuses. Separate entry because its vendored react-server-dom serializer loads only under that node condition; `renderServerTree` also imports the vendored client deserializer (inert in the same worker since deserialize-only never renders) and shims `__webpack_require__`/`__webpack_chunk_load__` internally. A thrown Server Component surfaces as a rejected promise (the stream still completes), not a hang. No hydration/interaction (that is the e2e tier). |
| `./testing/flight-matchers` | Vitest matchers for Flight strings: `flightMatchers` (`toMatchFlight` containment, `toMatchFlightSnapshot`). Split from `./testing/flight` so the renderer entry never top-level-imports `vitest` (an optional peer). Same `react-server` reachability as `./testing/flight` (it imports `normalizeFlight` from it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Internal (not user-facing)

These subpaths are consumed by the Vite plugin, RSC handler, or build tooling. They are not part of the public API and may change without notice.

| Export                               | Description                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `./server`                           | Manifest/build internals: plugin bridge, route-map management, router discovery registries |
| `./__internal`                       | Internal plumbing shared by build/runtime/Vite                                             |
| `./internal/deps/browser`            | Browser runtime dependency bridge                                                          |
| `./internal/deps/ssr`                | SSR runtime dependency bridge                                                              |
| `./internal/deps/rsc`                | RSC runtime dependency bridge                                                              |
| `./internal/deps/html-stream-client` | HTML stream client dependency bridge                                                       |
| `./internal/deps/html-stream-server` | HTML stream server dependency bridge                                                       |
| `./internal/rsc-handler`             | RSC handler internals                                                                      |
| `./cache-runtime`                    | Cache runtime dependencies                                                                 |
| `./types`                            | Type declarations for the `@rangojs/router:version` virtual module                         |

### CLI

The CLI is exposed via the `bin` field in `package.json`, not as a subpath export:

```
"bin": { "rango": "dist/bin/rango.js" }
```

`rango generate` — static/runtime route-type extraction for CI and repo bootstrapping.

---

## Client API

### Components

`Outlet`, `ParallelOutlet`, `Link`, `ScrollRestoration`, `Meta`, `MetaTags`, `Breadcrumbs`

### Hooks

| Hook                   | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `useLoader`            | Access loader data                      |
| `useFetchLoader`       | Client-side fetch loader                |
| `useRefreshLoaders`    | Refresh cross-loader refresh group(s)   |
| `useNavigation`        | Navigation state                        |
| `useRouter`            | Imperative navigation                   |
| `usePathname`          | Current pathname                        |
| `useSearchParams`      | Search parameters                       |
| `useParams`            | Route params                            |
| `useSegments`          | Segments state                          |
| `useAction`            | Server action state tracking            |
| `useHandle`            | Access handle data                      |
| `useLocationState`     | Navigation state persistence            |
| `useClientCache`       | Client cache controls                   |
| `useLinkStatus`        | Link navigation status                  |
| `useMount`             | `include()` mount context               |
| `useHref`              | Mount-aware href generation             |
| `useReverse`           | Local reverse for imported `routes` map |
| `useScrollRestoration` | Scroll restoration control              |
| `useTheme`             | Theme management (via `./theme`)        |

### Factories

`createLoader`, `createHandle`, `isHandle`, `createLocationState`, `href()`

---

## Feature Map by Capability

### Route DSL and Composition

`urls()`, `path()`, `layout()`, `include()`, `parallel()`, `intercept()`, `middleware()`, `cache()`, `loader()`, `loading()`, `errorBoundary()`, `notFoundBoundary()`, `transition()`, `when()`, `map()`, `route()`, `revalidate()`

### Router Lifecycle

Public API (`Rango` interface):

- `createRouter()` with `.routes()`, `.use()`, `.reverse()`, `.fetch()`
- `routeMap`, warmup handling, document wrapper, global not-found/error defaults
- Named cache profiles via `cacheProfiles`, nonce provider, version tracking
- Request timeouts via `timeout`/`timeouts`/`onTimeout` options
- `basename` for sub-path deployments — auto-prefixes all routes, `reverse()`, `Link`, `redirect()`, `router.use()` patterns, and `useRouter()` navigation. `href()` is intentionally not basename-aware (raw path helper).

Internal API (`RangoInternal`, not exported):

- `.match()`, `.matchPartial()`, `.matchError()`, `.previewMatch()`, `.matchForPrerender()`, `.renderStaticSegment()`
- `allowDebugManifest`, `debugManifest()`

### URL Typing and Generation

- `route()` macro expansion, `href()`, `href.<format>()`, `reverse()`, scoped reverse APIs
- `ResponseEnvelope` types and response-route type extraction

### Response Routes

`path.json()`, `path.text()`, `path.html()`, `path.xml()`, `path.md()`, `path.image()`, `path.stream()`, `path.any()`

Response middleware wrapping, automatic content negotiation, typed response envelopes, response error classification.

### Match and Execution Pipeline

URL pattern matching, middleware execution, segment resolution, error matching, route preview, partial matching, handler resolution for full requests, partial RSC, and actions.

### Data Loading

- `loader()` declarations, `createLoader()`, `useLoader()`, `useFetchLoader()`
- `fetchable` loader mode for cacheable JSON/resource paths
- Client refresh `key` (per-loader refresh groups) and `useRefreshLoaders()`
  (cross-loader refresh groups via `refreshGroup`; reads may carry multiple group
  tags, and the inverted hook takes the group(s) at call time)

### Request Context and Server Helpers

- `cookies()` -- `CookieStore` with `get`/`getAll`/`has`/`set`/`delete`
- `headers()` -- read-only header proxy
- `getRequestContext()` -- full request data server-side, plus shared variable access via `ctx.get()`/`ctx.set()`
- All guard against use inside `"use cache"` functions

### Search Parameters

Route-local schema definitions (`search` option), typed route param types (`RouteParams`, `RouteSearchParams`), runtime parse/serialize utilities.

### Cache Architecture

- Route-level segment caching (`cache()` DSL), named cache profiles (`cacheProfiles`)
- `cache()` + segment scope propagation, global segment cache config on router
- `"use cache"` directive runtime wrappers, response route cache layer

### Error and Control Flow

- `redirect()` with optional state and location state integration
- Typed error model: `RouteNotFoundError`, `DataNotFoundError`, etc.
- Not-found and error boundary propagation across the route tree

### Action System

Server action execution pipeline, `useAction()` state tracking, action ID extraction, lifecycle states, server action bridge, action-state UI coordination.

### Route Transitions and Partial Rendering

- Route-level loading boundaries via `loading()`
- Error/not-found boundary composition
- `transition()` — opts a route into same-route stale-while-revalidate AND (on experimental React) View Transition animation. (1) Content hold (all React versions): a route in a transition scope (itself, or any layout in its matched chain, declares `transition()`) gets a param-agnostic key in `segment-system.tsx` (`inTransitionScope` → `includeParams`), so a same-route param change (e.g. `/product/1` → `/product/2`) reconciles the route subtree instead of remounting it; the `startTransition` wrap `shouldStartViewTransition` already applies (`browser/partial-update.ts`) then holds the previous content while the new loader resolves — no skeleton flash. Cross-route navs and routes without `transition()` remount as before. (2) Animation (experimental React only): the segment content is wrapped in `<ViewTransition>`, so the held same-route swap morphs (`update`/`share`) and cross-route swaps animate `enter`/`exit`; wrap location depends on segment type (layout: default outlet content; route: route component; parallel/intercept slot: slot content). (3) Boundary opt-out: `transition({ viewTransition: false })` suppresses the `<ViewTransition>` wrap (job 2) while keeping the content hold and `startTransition` driving (job 1) — so consumer-placed `<ViewTransition>` elements still animate but rango adds no cross-fade of its own. `createRouter({ viewTransition: "auto" | false })` sets the app-wide default; the per-segment value wins. The global default is resolved into each segment's transition config during resolution (`router/segment-resolution/view-transition-default.ts` `applyViewTransitionDefault`, applied in `fresh.ts`/`revalidation.ts`; only `false` is stamped, unset/`"auto"` is left as-is) so the render gate (`segment-system.tsx`, `transition.viewTransition !== false`) reads the boundary decision off the segment on both server and client without threading the option to the client. See [skills/view-transitions](../../skills/view-transitions/SKILL.md).
- Parallel slot streaming: `loading()` + `loader()` on a parallel makes it an independent streaming unit (own `LoaderBoundary`, non-blocking across SSR, SPA navigation, and cache-hit paths). Without `loading()`, parallel loaders block the parent layout.
- Slot override dedup: last `parallel()` definition wins per `@slot` name, enabling composition overrides
- Modal/intercept rendering via `intercept()` with `when()` conditions

### Location State

- `createLocationState()` -- typed state definitions; each definition exposes `.read()`, `.write()`, and `.delete()` for static (non-reactive) access to its slot in `history.state`
- `useLocationState()` -- reactive hook; updates on popstate / `__rsc_locationstate` (does NOT update on static `.write()` / `.delete()`)
- `redirect()` integration with location state

### Handle Data

`createHandle`, `useHandle`, handle propagation from route handlers into client components, segment ordering and reconciler. Built-in: `Meta` handle for head tags, `Breadcrumbs` handle for breadcrumb navigation.

### Revalidation

- `revalidate()` DSL primitive
- Segment-level revalidation defaults, request-method aware behavior
- Custom revalidate callback composition, SWR background revalidation
- `ctx.isAction(...refs)` on the revalidate predicate context — typed,
  rename-safe action matching by reference (single, variadic, or `import * as`
  namespace); resolves the same id (`$id ?? $$id`) as the action boundary, so it
  matches in dev and production. Public type: `ActionRef` (exported from root).

### Progressive Enhancement

Internal: `handleProgressiveEnhancement()` (in `src/rsc/progressive-enhancement.ts`, not re-exported from `./rsc`) handles no-JS form submission, form-state encoding/decoding for `useActionState()`.

### Cross-tab Invalidation

Internal: `invalidateRangoState()` (in `src/browser/rango-state.ts`, not re-exported from `./browser`) triggers state invalidation across browser tabs via page visibility events.

### Theming

Router option `theme`, `ThemeProvider` integration on server and client, `ThemeScript` generation, FOUC prevention, cookie-based persistence.

### Prerender and Build-time Pre-rendering

- `Prerender()`/`Static()` handler types, `BuildContext`, `GetParamsContext`
- Pre-render manifest generation, intercept pre-render artifacts
- Runtime prerender cache lookup flow
- `Passthrough(prerenderDef, liveHandler)` wrapper for live runtime fallback
- `ctx.passthrough()` per-param artifact skip (defers to Passthrough live handler)
- `PRERENDER_PASSTHROUGH` sentinel, `isPrerenderPassthrough()` type guard
- `buildEnv` Vite plugin option for build-time `ctx.env` access (KV, D1, etc.)
- `"auto"` mode calls `wrangler.getPlatformProxy()` for Cloudflare presets
- Applies to both production build and dev `/__rsc_prerender` evaluation

### Request Timeouts

- `timeout` router option — shorthand number (ms), applies to `actionMs` + `renderStartMs`
- `timeouts` router option — structured `{ actionMs?, renderStartMs?, streamIdleMs? }`, overrides shorthand
- `onTimeout` router option — custom callback returning a `Response` for timed-out requests
- `RouterTimeoutError` — custom error class with `phase` and `durationMs`
- `withTimeout()` — `Promise.race` helper returning discriminated union
- Default 504 response with `X-Rango-Timeout-Phase` header
- `onError` receives timeout errors with `metadata: { timeout: true, phase, durationMs }`
- Timeout phases: `"action"` (server action execution), `"render-start"` (RSC render / response routes)
- `streamIdleMs` accepted but deferred (not enforced in PR 1)

### Telemetry and Observability

- `telemetry` router option — pluggable `TelemetrySink` for structured lifecycle events
- `createConsoleSink()` — development logger for all 10 event types
- `createOTelSink(tracer)` — OpenTelemetry adapter mapping events to `rango.*` spans
- Event types: `request.start/end/error`, `loader.start/end/error`, `handler.error`, `cache.decision`, `revalidation.decision`, `request.timeout`
- Zero overhead when no sink is configured (no-op singleton)
- Structurally typed OTel interfaces (`OTelTracer`, `OTelSpan`) — no `@opentelemetry/api` dependency

### Consumer Testing (`./testing`, `./testing/vitest`, `./testing/dom`, `./testing/e2e`, `./testing/flight`, `./testing/flight-matchers`)

- Six entries, split by the dependency/runtime each needs (so the unit barrel stays dependency-light): `./testing` (Vite-driven Vitest unit + integration), `./testing/vitest` (the `rangoTestAliases` setup preset), `./testing/dom` (`renderRoute`, needs RTL + a DOM env), `./testing/e2e` (Playwright harness), `./testing/flight` (RSC renderer, `react-server` condition), `./testing/flight-matchers` (Flight matchers; split out so the renderer never top-level-imports `vitest`). The `./testing` barrel never references React, `@testing-library/react`, `@playwright/test`, `vitest`, or the RSC runtime.
- Unit (`./testing`): `runMiddleware` (real `executeMiddleware` — ordering, return/throw short-circuit, header+cookie merge, `nextCalled`; result `cookies` = effective view, so a set cookie is assertable without the `@internal` ctx cast; no `handles`/`rendered` — middleware runs before the render barrier), `runLoader` (a registered `createLoader()` handle OR a raw loader fn against a real `RequestContext`; the handle's fn is recovered from the fetchable registry — `createLoader` assigns a runtime-fallback `$$id` + registers the fn even without the plugin, when imported through the server build, mirroring `createHandle`; `ctx.use` resolver via `opts.use`; `ctx.reverse` needs `routeMap`; `ctx.rendered()`/`isAction` unavailable; `handles`/`rendered` seed post-barrier handle reads).
- Integration: `dispatch` (`./testing`; accepts the public `Rango` router type, no cast; router -> Response for redirects/404/response routes/middleware short-circuits, NO Flight; mirrors `handleResponseRoute` error + `Vary: Accept` semantics; throws on RSC routes — so a RESPONSE route's real route-level guard stack runs here, but a COMPONENT route's is e2e-only). Setup via the `./testing/vitest` preset (`rangoTestConfig`) so `@rangojs/router` resolves to real impls, the plugin-rsc virtual is stubbed, and `server.deps.inline` lets Vite transpile rango's TS source; the FULL app router still can't be imported if it uses `Prerender`/`createLoader` (build-time `$$id`), so dispatch a router built from a `Prerender`-free include. `renderRoute` (`./testing/dom`; RTL-style client-tree stub; mounts the real `NavigationProvider`; seeds `loaderData` by `$$id`, plus `loaders`/`locationState`/`handles` by reference — handles are accumulated globally, so they reach layout components too; `mount` option models an `include()` prefix so `useMount`/`useHref`/`useReverse` resolve it; `basename`/`theme` options; client-tree fidelity only).
- RSC: `renderToFlightString` (wire string) + `flightMatchers` (`toMatchFlight` containment, `toMatchFlightSnapshot`), and `renderServerTree` (serialize -> deserialize an ELEMENT to an inspectable tree) + `findClientBoundaries(tree, name?)` for typed boundary-prop fidelity and inlined-vs-island, plus `renderHandler` (run a real route handler `(ctx) => rsc` with a seeded HandlerContext, returning the rendered tree + effect snapshot), under a dedicated `react-server`-condition vitest project (`vitest.rsc.config.ts`, `*.rsc-test.{ts,tsx}`, `pnpm test:unit:rsc`); `normalizeFlight`, `assertFlightRuntimeAvailable`, `assertFlightTreeRuntimeAvailable`. Add `rangoUseClientTransform()` (from `./testing/vitest`) to the rsc project's `plugins` so `renderServerTree` auto-discovers client islands from the server tree's imports; `clientComponents` is the no-transform fallback. Server-only/leaf scope; serialize->deserialize only, interactive hydrated `renderServer` intentionally not shipped (e2e tier).
- Cross-cutting cache/prerender: `assertCacheStatus`/`parseCacheHeader` read `X-Rango-Cache` (gated by `debugCacheSignal` / `RANGO_TEST_SIGNALS=1`, coarse route-level); `createCacheSink`/`filterCacheDecisions` zero-prod-surface telemetry path via `createRouter({ telemetry })`.
- Generated-route drift: `diffGeneratedRoutes`/`assertGeneratedRoutesMatch` compare runtime `routeMap` to the imported `*.named-routes.gen.ts` map.
- Advanced: `runInRequestContext` (build + enter a real ctx in one call — for an action/fn that reads `getRequestContext()`/`cookies()` but has no loader-context shape; returns `{ result, thrown, response, cookies, headers, locationState }` (type `RunInRequestContextResult`) so an action's Set-Cookie / response-header / flash output is assertable without the `@internal` `ctx.res`/`ctx.cookies()` cast (`headers` is the response-header view as a plain object, excluding set-cookie, including a thrown redirect's Location; `runMiddleware` surfaces the same `headers`). The snapshot is captured whether `fn` returns OR throws — the dominant success path is `throw redirect()` after setting a cookie+flash, so `thrown` holds the captured-not-re-thrown redirect Response and `response` merges its Location with the cookies), `runWithRequestContext` (re-export; enter a ctx already built), `createTestRequestContext`, `toRequest`, `seedVariables`.
- E2E harness (`./testing/e2e`) `createRangoE2E({ test, expect, defaultRoot? })`: `useFixture` (dev/preview spawn + dep-optimizer warmup + cross-platform process-group kill), `parityDescribe` (one body -> dev + auto-`(production)` describes, enforcing the dev/prod mandate structurally), `expectParity` (JS vs no-JS PE parity; submit settles on observed DOM, with a `waitFor` escape hatch), `rangoMatchers.toHaveRangoPathname` (+ Playwright type augmentation), page helpers (`waitForHydration`, `expectNoReload`, `expectNoPageError`, navigation/timing helpers), `testNoJs`.

### Dev and HMR

`rango()` plugin discovery, named-route generation, manifest virtual modules, parser/runtime route-type fallback, lazy loader id injection, duplicate plugin detection. `poke()` — dev-only Vite plugin that triggers a full browser reload from terminal input: `Ctrl+R` when available, plus safe line-based shortcuts like `e + Enter`.

---

## Architecture Map

```
App Authoring ──> Router ──> Runtime ──> Rendering ──> Client
                    │                       │
                    └── Cache ──────────────┘
                    │
Tooling ────────────┘
```

| Layer         | Source                                    | Responsibility                                                                                                    |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| App authoring | `src/route-definition/*`, `src/router.ts` | Compile route DSL into manifest entries for `router.match()`                                                      |
| Router        | `src/router/*`, `src/server/context*`     | Manifest cache, middleware execution, segment pipelines, error handling, action context, revalidation             |
| Rendering     | `src/rsc/*`, `src/ssr/*`                  | Stream RSC payloads, execute server actions/loaders/response routes, emit HTML with bootstrap and flight payloads |
| Client        | `src/browser/*`                           | UI state via NavigationStore, links, prefetch, router actions, server-action bridges                              |
| Tooling       | `src/vite/*`, `src/build/*`               | Route typings/manifests, plugin/version/runtime metadata, HMR consistency                                         |
| Cache         | `src/cache/*`                             | Cache scopes + stores for segment responses and response routes with SWR semantics                                |
| Extensions    | `src/theme/*`, `src/host/*`               | Theme system, domain-based multi-app composition                                                                  |

---

## Optional / Advanced Features

- Cloudflare preset mode in `rango()` with environment-specific build setup
- `clientChunks` Vite plugin option (`false` | `true` | function; exported types
  `ClientChunks`, `ClientChunkMeta`) — per-route/per-feature splitting of the
  client (`"use client"`) bundle. The built-in strategy (`true`) groups app client
  modules by **route id** (the segment after a route-root marker such as
  `routes`/`app`/`pages`/`features`/`handlers`), and returns `undefined` where
  there is no route structure so flat layouts and host-split sub-apps inherit the
  default grouping unchanged (no collision, no cross-app merge). A function is
  forwarded to `@vitejs/plugin-rsc`'s `clientChunks`. Shared runtime
  (React/router/`node_modules`) stays unsplit. **On by default pre-1.0**; opt out
  with `clientChunks: false`. See [client-chunking.md](../client-chunking.md).
- Runtime CLI route extraction (`rango generate <paths>`) for CI and repo bootstrapping
- Debug surfaces: `debugManifest()`, `getMatchDebugStats()`, strict runtime/per-route tracing in development
- Internal instrumentation and plugin internals for multi-router deployments and manifest isolation
