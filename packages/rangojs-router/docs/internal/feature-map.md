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

| Export           | Description                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`              | Root entrypoint with shared types/utilities plus server/RSC APIs selected via the `react-server` export condition: `createRouter`, `createLoader`, `redirect`, `cookies()`, `headers()`, route DSL, errors, helpers, URL/route utilities, reverse lookup. Default (non-RSC) entry also exports universal handles `Meta` and `Breadcrumbs` alongside `createHandle`. |
| `./client`       | Client-side components and hooks (see [Client API](#client-api) below)                                                                                                                                                                                                                                                                                              |
| `./vite`         | Public Vite plugin surface: `rango()`, `poke()`, and plugin option types                                                                                                                                                                                                                                                                                            |
| `./browser`      | Browser bootstrap: `initBrowserApp`, `RSCRouter`, `InitBrowserAppOptions`                                                                                                                                                                                                                                                                                           |
| `./rsc`          | Advanced server request-pipeline APIs: `createRSCHandler`, request-context access, RSC handler types                                                                                                                                                                                                                                                                |
| `./ssr`          | Advanced HTML rendering bridge: `createSSRHandler`, nonce/form-state/streamMode support                                                                                                                                                                                                                                                                             |
| `./build`        | Manifest and route-type generators: `generateManifest`, `generateManifestFull`, `generateManifestCode`, `writePerModuleRouteTypes`, `generatePerModuleTypesSource`, `extractRoutesFromSource`, `buildRouteTrie`, `createScanFilter`, `hashParams`                                                                                                                   |
| `./cache`        | Segment and response cache APIs: `SegmentCacheStore`, `MemorySegmentCacheStore`, `CFCacheStore` (L1 + optional KV L2), `KVNamespace`, document cache middleware, cache scope utilities                                                                                                                                                                              |
| `./theme`        | Theming public API: `useTheme`, `ThemeProvider`, `ThemeScript`, theme constants                                                                                                                                                                                                                                                                                     |
| `./host`         | Host-based multi-app routing: `createHostRouter`, `defineHosts`, host matching types                                                                                                                                                                                                                                                                                |
| `./host/testing` | Host router test helpers                                                                                                                                                                                                                                                                                                                                            |

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

Public API (`RSCRouter` interface):

- `createRouter()` with `.routes()`, `.use()`, `.reverse()`, `.fetch()`
- `routeMap`, warmup handling, document wrapper, global not-found/error defaults
- Named cache profiles via `cacheProfiles`, nonce provider, version tracking
- Request timeouts via `timeout`/`timeouts`/`onTimeout` options
- `basename` for sub-path deployments — auto-prefixes all routes, `reverse()`, `Link`, `redirect()`, `router.use()` patterns, and `useRouter()` navigation. `href()` is intentionally not basename-aware (raw path helper).

Internal API (`RSCRouterInternal`, not exported):

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
- View Transition config via `transition()` — wrap location depends on segment type (layout: default outlet content; route: route component; parallel/intercept slot: slot content). See [skills/view-transitions](../../skills/view-transitions/SKILL.md).
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
- Runtime CLI route extraction (`rango generate <paths>`) for CI and repo bootstrapping
- Debug surfaces: `debugManifest()`, `getMatchDebugStats()`, strict runtime/per-route tracing in development
- Internal instrumentation and plugin internals for multi-router deployments and manifest isolation
