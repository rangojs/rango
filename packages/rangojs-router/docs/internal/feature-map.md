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

| Export           | Description                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`              | Universal router API: `createRouter`, `createLoader`, `redirect`, `cookies()`, `headers()`, route DSL, errors, helpers, URL/route utilities, reverse lookup, server-only runtime helpers                                                          |
| `./client`       | Client-side components and hooks (see [Client API](#client-api) below)                                                                                                                                                                            |
| `./vite`         | `rango()` plugin factory and plugin options                                                                                                                                                                                                       |
| `./browser`      | Browser bootstrap: `initBrowserApp`, `RSCRouter`, `InitBrowserAppOptions`                                                                                                                                                                         |
| `./rsc`          | Advanced server APIs: `createRSCHandler`, server-side request context, handle store, segment cache types                                                                                                                                          |
| `./ssr`          | RSC payload to HTML bridge: `createSSRHandler`, nonce/form-state support                                                                                                                                                                          |
| `./build`        | Manifest and route-type generators: `generateManifest`, `generateManifestFull`, `generateManifestCode`, `writePerModuleRouteTypes`, `generatePerModuleTypesSource`, `extractRoutesFromSource`, `buildRouteTrie`, `createScanFilter`, `hashParams` |
| `./cache`        | Segment and response cache APIs: `SegmentCacheStore`, `MemorySegmentCacheStore`, `CFCacheStore`, document cache middleware, cache scope utilities                                                                                                 |
| `./theme`        | Theming client API: `useTheme`, `ThemeProvider`, theme scripts and constants                                                                                                                                                                      |
| `./host`         | Host-based multi-app routing: `createHostRouter`, `defineHosts`, host matching types                                                                                                                                                              |
| `./host/testing` | Host router test helpers                                                                                                                                                                                                                          |

### Internal (not user-facing)

These subpaths are consumed by the Vite plugin, RSC handler, or build tooling. They are not part of the public API and may change without notice.

| Export                               | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `./server`                           | Manifest/build internals: plugin bridge, route-map management      |
| `./__internal`                       | Internal plumbing shared by build/runtime/Vite                     |
| `./internal/deps/browser`            | Browser runtime dependency bridge                                  |
| `./internal/deps/ssr`                | SSR runtime dependency bridge                                      |
| `./internal/deps/rsc`                | RSC runtime dependency bridge                                      |
| `./internal/deps/html-stream-client` | HTML stream client dependency bridge                               |
| `./internal/deps/html-stream-server` | HTML stream server dependency bridge                               |
| `./internal/rsc-handler`             | RSC handler internals                                              |
| `./cache-runtime`                    | Cache runtime dependencies                                         |
| `./types`                            | Type declarations for the `@rangojs/router:version` virtual module |

### CLI

The CLI is exposed via the `bin` field in `package.json`, not as a subpath export:

```
"bin": { "rango": "dist/bin/rango.js" }
```

`rango generate` — static/runtime route-type extraction for CI and repo bootstrapping.

---

## Client API

### Components

`Outlet`, `ParallelOutlet`, `Link`, `ScrollRestoration`, `Meta`, `MetaTags`

### Hooks

| Hook                   | Purpose                          |
| ---------------------- | -------------------------------- |
| `useLoader`            | Access loader data               |
| `useFetchLoader`       | Client-side fetch loader         |
| `useLoaderData`        | All loader data in context       |
| `useNavigation`        | Navigation state                 |
| `useRouter`            | Imperative navigation            |
| `usePathname`          | Current pathname                 |
| `useSearchParams`      | Search parameters                |
| `useParams`            | Route params                     |
| `useSegments`          | Segments state                   |
| `useAction`            | Server action state tracking     |
| `useHandle`            | Access handle data               |
| `useLocationState`     | Navigation state persistence     |
| `useClientCache`       | Client cache controls            |
| `useLinkStatus`        | Link navigation status           |
| `useMount`             | `include()` mount context        |
| `useHref`              | Mount-aware href generation      |
| `useScrollRestoration` | Scroll restoration control       |
| `useTheme`             | Theme management (via `./theme`) |

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

- `loader()` declarations, `createLoader()`, `useLoader()`, `useFetchLoader()`, `useLoaderData()`
- `fetchable` loader mode for cacheable JSON/resource paths

### Request Context and Server Helpers

- `cookies()` -- `CookieStore` with `get`/`getAll`/`has`/`set`/`delete`
- `headers()` -- read-only header proxy
- `getRequestContext()` -- full request data server-side
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
- View Transition config via `transition()`
- Parallel slots and modal/intercept rendering

### Location State

- `createLocationState()` -- typed state definitions
- `useLocationState()` -- read/write navigation state
- `redirect()` integration with location state

### Handle Data

`createHandle`, `useHandle`, handle propagation from route handlers into client components, segment ordering and reconciler. Built-in: `Meta` handle for head tags.

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

### Dev and HMR

`rango()` plugin discovery, named-route generation, manifest virtual modules, parser/runtime route-type fallback, lazy loader id injection, duplicate plugin detection.

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
