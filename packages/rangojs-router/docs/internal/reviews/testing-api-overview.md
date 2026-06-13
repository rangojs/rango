# Testing surface — high-level API overview

> Internal reference. Produced by the 2026-06-13 multi-agent review of the
> `@rangojs/router/testing` surface (PR #533). Keep in sync with the six
> testing entries + `@rangojs/router/host/testing` and the `skills/testing/`
> consumer docs. Not shipped (docs/ is excluded from the package `files`).

## @rangojs/router Testing Surface: High-Level API Overview

### Purpose and Scope

The testing surface ships as six separate entries in `package.json` exports, each addressing a distinct test context and dependency boundary:

1. **`@rangojs/router/testing`** — Core unit and integration primitives (loaders, middleware, response routes)
2. **`@rangojs/router/testing/vitest`** — Setup helpers: `rangoTestConfig`, `rangoTestAliases`, `rangoUseClientTransform`
3. **`@rangojs/router/testing/dom`** — Component render testing: `renderRoute`
4. **`@rangojs/router/testing/e2e`** — Playwright harness: `createRangoE2E`, `parityDescribe`, `expectParity`
5. **`@rangojs/router/testing/flight`** — Real Flight rendering (react-server condition only): `renderToFlightString`, `renderServerTree`, `renderHandler`
6. **`@rangojs/router/testing/flight-matchers`** — Vitest custom matchers: `toMatchFlight`, `toMatchFlightSnapshot`

Plus **`@rangojs/router/host/testing`** for host-router pattern matching.

### Entry-by-Entry Breakdown

#### `@rangojs/router/testing` — Unit and Integration (the core barrel)

**Runtime:** Node (Vitest, no React, no RTL, no Playwright)

**Purpose:** Test loaders, middleware, response routes, and cross-cutting concerns (cache signals, generated route drift, handle collection) without a server or browser.

**Key Primitives:**

- **`runMiddleware(fn, opts)`** → `{ response, ctx, nextCalled, cookies, headers, locationState }` — Execute a single middleware function with seeded request state, capture its effects.
- **`runLoader(fn | LoaderHandle, opts)`** → `T` — Run a loader body or `createLoader()` handle and return its data (effects not captured).
- **`runLoaderResult(fn | LoaderHandle, opts)`** → `{ result: T | undefined, thrown, response, cookies, headers, locationState, stateCookieName }` — Same as above but also capture effects (Set-Cookie, redirects).
- **`dispatch(router, opts)`** → `Response` — Full request→response for response routes, redirects, 404s, middleware chains. Does NOT render RSC.
- **`runInRequestContext(fn, opts)`** → `{ result, thrown, response, cookies, headers, locationState, stateCookieName }` — Unit-test a server action or any function reading the request context.
- **Cache status helpers:** `assertCacheStatus`, `parseCacheHeader`, `createCacheSink`, `filterCacheDecisions` — Assert cache hits/misses/stale via X-Rango-Cache header or telemetry events.
- **Route type drift:** `diffGeneratedRoutes`, `assertGeneratedRoutesMatch` — Detect runtime/generated-file mismatches.
- **Handle collection:** `collectHandle(handle, segments)` — Unit-test a handle's `collect` accumulator.
- **Advanced context builders:** `createTestRequestContext`, `toRequest`, `seedVariables` — Bespoke RequestContext setups for custom test logic.

**Seeding contract:**

- `params` — Route params
- `search` (raw) + `searchData` (typed) — Query string
- `env` — Environment bindings (e.g., `DB`, `KV`)
- `vars` — Request context variables
- `routeMap` + `routeName` — Reverse URL generation
- `basename` — Prefix for redirect() call resolution
- `theme` — Theme config (e.g., for `ctx.theme`)
- `cacheStore` + `cacheProfiles` — Cache stores and profile definitions
- `stateCookie` — Customize the rango state cookie name (used by `invalidateClientCache()`)
- `rendered` + `handles` — Mock the render barrier (loaders only)
- `loaders` — Seed `ctx.use(OtherLoader)` by reference
- `method`, `body`, `formData` — HTTP method and request payload

**Key trait:** Never imports React, RTL, or Playwright. A suite testing only loaders/middleware depends on none of them.

#### `@rangojs/router/testing/vitest` — Setup Preset and Configuration

**Runtime:** Node (loaded by `vitest.config.ts`; exports as compiled JS)

**Purpose:** Wire the aliases and inlining config Vitest needs to import a real app's router/loaders/middleware.

**Key Exports:**

- **`rangoTestConfig(opts?)`** → `{ alias: [...], server: { deps: { inline: [...] } } }` — One-call setup: spreads into `test` block.
- **`rangoTestAliases(opts?)`** → `TestAlias[]` — Just the aliases (lower-level; wire `deps.inline` yourself if you use this).
- **`rangoInlineDeps`** — `RegExp[]` matching `@rangojs/router`; forces Vite (not Node) to transpile TS source on Node >= 23.
- **`rangoUseClientTransform()`** → Vite plugin — Applies the "use client" transform in the react-server Vitest project so `renderServerTree` auto-discovers islands.

**Presets:**

- `preset: "node"` (default) — Stubs `@rangojs/router:version` and `@vitejs/plugin-rsc/rsc` virtuals.
- `preset: "cloudflare"` — Additionally stubs `cloudflare:workers` and `cloudflare:email` runtime virtuals.

**Critical detail:** The aliases point the bare `@rangojs/router` specifier to `index.rsc.ts` (the react-server build with real impls) while leaving React as the client build. This surgical approach lets a test import the app's router without flipping React globally to the server build (which would crash). The alias is applied **per-test-project** — the default project uses it, and the Flight project ALSO uses it (required when rendering handlers/components that import `getRequestContext()` / `cookies()`).

#### `@rangojs/router/testing/dom` — Component Render Testing

**Runtime:** Happy-dom or jsdom (Vitest, RTL optional peer)

**Purpose:** Test client components reading router context (useParams, useReverse, Outlet, useNavigation, useLoader) in isolation without a server or real hydration.

**Key Primitive:**

- **`renderRoute(specs, opts)`** → `{ getByTestId, ..., router, navigate }` — RTL-style stub mounting the component tree under a real `NavigationProvider` and context, seeding loader data, location state, and handles by reference.

**Specs shape:** `{ path, Component, layout?, loaderIds?, name? }[]` — the layout chain from root to leaf.

**Seeding model:**

- `loaderData` — RTL-style keyed by `$$id` (useful for explicit control)
- `loaders` — Reference-based tuples `[[LoaderHandle, data]]` (preferred; avoids $$id collision)
- `locationState` — `[[LocationStateRef, value]]` tuples
- `handles` — `[[HandleRef, pushedValues[]]]` tuples
- `mount` — Include mount prefix for `useMount()` / `useReverse()` scoping
- `request` — Backing request (string or Request)
- `params` — Route params
- `theme` — Theme config

**Key trait:** Lazy-loads `@testing-library/react` at call time. Kept separate from the main barrel so node-only unit suites depend on neither React nor RTL.

#### `@rangojs/router/testing/e2e` — Playwright Harness

**Runtime:** Playwright (plain Node, loadable without Vite)

**Purpose:** Orchestrate real dev/prod server runs with parity assertions (JS on/off for progressive enhancement), cache signals, page helpers, and navigation lifecycle.

**Key Exports:**

- **`createRangoE2E({ test, expect, defaultRoot })`** → full harness — Wire the consumer's Playwright `test`/`expect` into the harness (no runtime imports of `@playwright/test`).

**Returned harness:**

- **`useFixture(opts)`** → `{ url, page, context }` — Spawn a dev or prod server instance, point Playwright at it.
- **`parityDescribe(title, fn(t))`** — Describe block that runs the test twice (JS on, JS off) and asserts parity (observable behavior is identical).
- **`expectParity(assertion)`** → assertion proxy — Asserts that the same check passes on both JS-on and JS-off runs.
- **Page helpers:** `waitForHydration()`, `waitForNavigation()`, `goBack()`, `goForward()`, `getHistoryState()`, `waitForElement()`, `isVisibleInViewport()`, `parseNumber()`, `getNumericContent()`, `createStopwatch()`, `measureTime()`.
- **`testNoJs`** — Test variant with JavaScript disabled (paired with `parityDescribe`).
- **`rangoMatchers`** — Custom matchers: `toHaveRangoPathname()`.
- **Cache-status re-exports:** `assertCacheStatus`, `parseCacheHeader`, `createCacheSink`, `filterCacheDecisions` — Usable in Playwright (the main barrel can't be imported there because it pulls the build-only virtual).

#### `@rangojs/router/testing/flight` — Real Flight Rendering

**Runtime:** Node with `react-server` condition (Vitest project `*.rsc-test.{ts,tsx}`, run via `pnpm test:unit:rsc`)

**Purpose:** Test async Server Components and route handlers with real Flight serialization, inspecting the wire payload and deserialized tree.

**Key Primitives:**

- **`renderToFlightString(element, opts?)`** → `string` — Serialize a server component (or element tree) to the Flight wire format (used for snapshots and containment matchers).
- **`renderServerTree(element, opts?)`** → `{ tree, flight }` — Serialize + deserialize to inspect the tree structure, client boundary props (as real values, not opaque encodings), and verify inlining vs. islands.
- **`findClientBoundaries(tree, selector?)`** → `ClientBoundary[]` — Query the deserialized tree for "use client" islands by name, testId, props, or custom predicate; returns `{ id, name, props, children }` records.
- **`findElements(tree, selector?)`** → `FoundElement[]` — Query server-rendered host elements (tag, props, text, children); selector is tag name, testId, or object filter.
- **`textContent(node)`** → `string` — Concatenate all text leaf nodes in a subtree (replaces `JSON.stringify(tree).toContain(...)`).
- **`renderHandler(handler, opts)`** → `{ tree, flight, thrown, response, cookies, headers, locationState, stateCookieName, handles }` — Run a real route handler `(ctx) => rsc` with a seeded `HandlerContext`, capture effects and the rendered RSC.
- **`normalizeFlight(wireString)`** → normalized string — Strip dev-only rows and absolute paths so assertions are stable (also used by the matchers).
- **`assertFlightRuntimeAvailable()` / `assertFlightTreeRuntimeAvailable()`** — Runtime checks that the react-server condition is active (errors helpfully if misconfigured).

**Seeding contract:** Same as `runInRequestContext` (env, request, headers, vars, params, routeName, routeMap, loaders, stateCookie). Plus `clientComponents` to register "use client" boundaries when `rangoUseClientTransform()` is not wired.

**Key traits:**

- Imports the vendored react-server-dom serializer; only usable under `react-server` condition.
- Returns both the wire `flight` string AND the deserialized `tree` for assertion flexibility.
- Intentionally does NOT hydrate or make trees interactive — that's the e2e tier.
- A thrown redirect/notFound is captured on `thrown`; tree is `undefined` in that case.
- An unseeded loader rejects (not bypassed like in the non-RSC tier).

#### `@rangojs/router/testing/flight-matchers` — Flight Wire Matchers

**Runtime:** Vitest (node, not react-server)

**Purpose:** Assert on Flight wire strings produced by `renderToFlightString`. Importable from shared `setupFiles` without pulling the react-server-only serializer.

**Key Exports:**

- **`flightMatchers`** — Object with two matchers:
  - **`toMatchFlight(expected)`** — Assert the normalized Flight string **contains** the substring `expected` (containment, not equality; row framing is an internal detail).
  - **`toMatchFlightSnapshot()`** — Snapshot the normalized Flight string via Vitest's snapshot engine.

**Critical detail:** Imports `normalizeFlight` from `flight-normalize.ts` (NOT from `flight.ts`), avoiding the react-server-only serializer. Allows a consumer to do `expect.extend(flightMatchers)` in their `setupFiles` and use the matchers across all projects without conditional imports.

**Type augmentation:** Declares `Assertion.toMatchFlight()` and `toMatchFlightSnapshot()` so TypeScript recognizes the matchers on `expect(...)`.

#### `@rangojs/router/host/testing` — Host Router Helpers

**Runtime:** Node

**Purpose:** Test host router pattern matching and request parsing.

**Key Exports:**

- **`createTestRequest(opts)`** → `Request` — Build a test request with specific host, path, cookies, headers.
- **`testPattern(pattern | pattern[], hostname, pathname?)`** → `boolean` — Check if a host/path pattern matches given strings (pathname defaults to "/").
- **`matchesHost(pattern | pattern[], request)`** → `boolean` — Check if a pattern matches a Request's hostname/pathname (parsed via the host router's own parser).

**Key trait:** These are shallow utilities for pattern testing only. No dispatch-like primitive exists for host routing (a consumer must build the host router and invoke it, or drop to e2e).

### Layer Stack: Unit → E2E

1. **Pure units** (no router context) — test a utility directly. Milliseconds.
2. **Unit (node context-bound)** — `runLoader`, `runMiddleware`, `runInRequestContext`, `dispatch`. Seeded request state, no server.
3. **Component unit (DOM)** — `renderRoute`. Real `NavigationProvider`, seeded data, no server.
4. **RSC unit** — `renderToFlightString`, `renderServerTree`, `renderHandler`. Real Flight serialization, no server, no hydration.
5. **E2E** — `parityDescribe`, `useFixture`. Real server, real hydration, real navigation, JS on/off parity.

### Public Primitives by Category

#### By Test Layer

**Unit (node):**

- `runMiddleware`
- `runLoader` / `runLoaderResult`
- `runInRequestContext` (for server actions)
- `dispatch` (response routes)
- `collectHandle`
- `diffGeneratedRoutes` / `assertGeneratedRoutesMatch`

**Unit (DOM):**

- `renderRoute`

**Unit (RSC):**

- `renderToFlightString` / `renderServerTree` / `renderHandler`
- `findClientBoundaries` / `findElements` / `textContent`
- `toMatchFlight` / `toMatchFlightSnapshot` (matchers)

**E2E:**

- `createRangoE2E` (harness factory)
- `parityDescribe` / `expectParity`
- `useFixture`
- `waitForHydration` / `waitForNavigation` / page helpers
- `assertCacheStatus` (also available in e2e import)

**Cross-cutting (all layers):**

- `assertCacheStatus` / `parseCacheHeader` / `createCacheSink` / `filterCacheDecisions`
- `createTestRequestContext` / `toRequest` / `seedVariables` (for bespoke setups)

#### By Concern

**Loader testing:** `runLoader` (bare data), `runLoaderResult` (data + effects), seeded via `loaders` (reference tuples).

**Middleware testing:** `runMiddleware`, seeded via `vars`.

**Server action testing:** `runInRequestContext`, same seeding as `runMiddleware`.

**Response route testing:** `dispatch`, seeded at route-matching level (no per-loader seeding).

**Component testing:** `renderRoute`, seeded via `loaders` (by reference), `locationState`, `handles`, `mount`.

**Server component testing:** `renderServerTree`, seeded via `vars` / `headers` / `params` / `loaders`.

**Route handler testing:** `renderHandler`, same seeding as loaders + handles + client boundary config.

**Host routing testing:** `testPattern` / `matchesHost` (pattern validation only).

**Progressive enhancement parity:** `parityDescribe` + `expectParity` (e2e only).

**Cache behavior:** `assertCacheStatus` / telemetry sink (e2e or seeded stores at unit).

### Deliberate Gaps (Not Covered)

1. **Hydration and interaction** — no in-process hydration in happy-dom/jsdom. Real browser is e2e only.
2. **Flying coast-to-coast** — no real Flight serialization without react-server condition.
3. **Global middleware on component routes** — `dispatch` rejects component routes; extract middleware to `runMiddleware` or test at e2e.
4. **Platform bindings** (`env.DB`, `env.KV`, `env.D1`) — app-specific. Consumers inject doubles via `env` option.
5. **`ctx.onError()` side effects** — `dispatch` does not invoke `onError` handlers. Test via e2e.
6. **Location-state-carrying partial redirects** — `dispatch` lacks Flight stream for embedding location state on redirect. Unit test the loader's effects; verify redirect restoration at e2e.

### Design Constraints and Walls

**Runtime walls (enforce the split):**

- The react-server-dom serializer (Flight) throws outside `react-server` condition → separate `./testing/flight` entry.
- React server build (no `createContext`) conflicts with client React → `rangoTestAliases` applies alias per-project, not globally.
- RTL and Playwright are optional peers → separate `./testing/dom` and `./testing/e2e` entries.

**Test-runner gates (allow fallbacks):**

- `Prerender()` / `createLoader()` / `Static()` construct with runtime-fallback `$$id` only under `process.env.VITEST` → bare tests don't throw "missing $$id".
- `isUnderTestRunner()` in `runtime-env.ts` allows other relaxations (e.g., `$$id` fallbacks, `allowServerInTest` for component-utils).

**Seeding coherence:**

- All primitives share a `CreateTestContextOptions` / request-context builder, so `params`, `env`, `vars`, `routeMap`, `stateCookie` work consistently across `runLoader`, `runMiddleware`, `dispatch`, `renderHandler`, etc.
- Loaders are seeded by reference (via `loaders` tuples), not by id, to avoid $$id collision in bare tests.
- Handles are seeded by reference too (via `handles` tuples), mirroring the loader model.

### Honest Limits

1. **Whole-router imports** — a consumer's router file may pull app-specific page modules or plugin `virtual:` modules that need the rango Vite plugin. Build from a focused include (e.g., API routes) for `dispatch` / drift checks, or run whole-router tests at e2e.
2. **Search schema typing** — `opts.search` (raw string) and `opts.searchData` (typed object) are separate. A loader reading `ctx.search` sees only what `searchData` provides; the raw `searchParams` reflect `search`.
3. **Unseeded loaders** — in `renderRoute` and `renderHandler`, an unseeded loader read defaults to `undefined` data (does not throw or default to the body's fallback return).
4. **Streaming Suspense** — a `use(promise)` inside `<Suspense>` does not flush when the promise resolves in happy-dom/RTL without an `act` boundary. Assert the fallback for pending, pass a pre-settled promise for the resolved state, or test interaction at e2e.
5. **Cache hit/miss/stale** — without a seeded `cacheStore`, `use cache` functions bypass (registerCachedFunction checks for a store first), so unit tests of cached logic run uncached. Real hit/miss/stale is e2e.

### Import Hygiene and Reachability

| Entry                       | Purpose              | Can import            | Cannot import                           | Load-time?                  |
| --------------------------- | -------------------- | --------------------- | --------------------------------------- | --------------------------- |
| `./testing`                 | Unit/integration     | Vitest (node)         | React, RTL, Playwright, virtual modules | Runtime                     |
| `./testing/vitest`          | Setup preset         | Node                  | (N/A)                                   | Load-time (compiled JS)     |
| `./testing/dom`             | Component test       | Vitest (DOM)          | Playwright, virtual modules             | Runtime                     |
| `./testing/e2e`             | Playwright harness   | Playwright            | (N/A)                                   | Runtime (type-only imports) |
| `./testing/flight`          | RSC render           | Vitest (react-server) | non-react-server Node                   | Runtime                     |
| `./testing/flight-matchers` | Flight matchers      | Vitest (any)          | react-server serializer                 | Runtime                     |
| `./host/testing`            | Host pattern testing | Node                  | (N/A)                                   | Runtime                     |

The split is enforced: importing `./testing` in Playwright fails (pulls virtual modules); importing `./testing/flight` in plain node fails (pulls react-server serializer); importing `./testing/e2e` in `vitest.config.ts` loads types only, never the Playwright runtime at load-time.
