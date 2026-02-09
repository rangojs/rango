# Response Routes Design

## Problem

Routes can return `Response` objects instead of JSX (JSON APIs, `robots.txt`, plain text). This works today via a throw/catch mechanism in `handleHandlerResult()`, but has two issues:

1. **Client-side navigation breaks silently** -- the browser expects Flight data during partial renders. Fixed by `X-RSC-Reload` fallback (PR #140), but this adds a wasted round-trip.
2. **No clean code path** -- Response-returning handlers enter the full RSC segment pipeline (route matching -> segment resolution -> handler execution -> throw Response -> catch). The handler runs inside `resolveSegments()`, which expects `ReactNode` returns.

## Motivation: Composable Mounting

The primary use case is `include()` composability. A third-party module exports `UrlPatterns` containing both JSX pages and API endpoints:

```typescript
// vendor-app/urls.tsx
export const vendorPatterns = urls(({ path }) => [
  path("/", DashboardPage, { name: "index" }),
  path("/settings", SettingsPage, { name: "settings" }),
  path("/api/data", dataHandler, { name: "apiData", ...path.JSON }),
  path("/api/webhook", webhookHandler, { name: "webhook", ...path.JSON }),
]);

// consumer app -- mounts everything, doesn't need to know which routes are JSX vs API
include("/vendor", vendorPatterns, { name: "vendor" })
```

The consumer doesn't need to know which routes are JSX and which are API -- the framework handles both correctly. `ctx.href("vendor.apiData")` resolves the URL from anywhere.

## API Design

### Tag functions

`urls`, `path`, `include`, and `href` get typed variants as methods: `.JSON`, `.TEXT`, `.IMAGE`, `.ANY`. Same signature as the base function, but marks the route as non-RSC.

```typescript
urls.JSON     // urls() where all routes serve JSON (module-level declaration)
urls.TEXT
urls.ANY

path.JSON     // path() that returns application/json
path.TEXT     // path() that returns text/plain
path.IMAGE    // path() that returns image/*
path.ANY      // path() that returns anything but RSC/html

include.JSON  // include() override -- all child routes serve JSON
include.TEXT
include.ANY

href.JSON     // href() that returns Link props with data-external
href.TEXT
href.ANY
```

### Route definition

**Module-level: `urls.JSON()` -- the module declares its own response type**

```typescript
// api-module/urls.tsx -- author knows all routes here are JSON
export const apiPatterns = urls.JSON(({ path }) => [
  path("/health", healthHandler, { name: "health" }),
  path("/products", productsHandler, { name: "products" }),
  path("/products/:id", productDetailHandler, { name: "productDetail" }),
]);

// consumer -- plain include(), response type comes from the patterns
include("/api", apiPatterns, { name: "api" })
```

**Per-route: `path.JSON()` -- mixed modules with some API routes**

```typescript
urls(({ path, include }) => [
  // JSON API endpoint alongside JSX routes
  path.JSON("/api/health", healthHandler, { name: "health" }),

  // Plain text route
  path.TEXT("/robots.txt", robotsHandler, { name: "robots" }),

  // Module declares its own type -- consumer doesn't need to know
  include("/api", apiPatterns, { name: "api" }),

  // Override: force JSON even if patterns don't declare it
  include.JSON("/legacy-api", legacyPatterns, { name: "legacyApi" }),

  // Regular JSX routes -- plain path(), default behavior
  path("/", HomePage, { name: "home" }),
])
```

### Client-side usage

`href.JSON()` returns an object that spreads directly into `<Link>` props:

```typescript
// href.JSON("/api/health") returns { to: "/api/health", "data-external": true }

// Client component
<Link {...href.JSON("/api/health")}>Check Health</Link>

// Server component with named route
<Link {...href.JSON(ctx.href("api.health"))}>Check Health</Link>

// ANY -- don't care about specific type, just "not RSC"
<Link {...href.ANY("/api/health")}>Check Health</Link>

// Regular RSC link -- plain href(), no tag
<Link to={href("/about")}>About</Link>
```

### TypeScript constraints

Response-type routes have narrower types than JSX routes. This prevents misuse at compile time.

**Handler return type** — must return `Response`, not `ReactNode`:

```typescript
// Regular path() — handler can return JSX or Response
path("/about", (ctx) => <AboutPage />)
path("/old", (ctx) => Response.redirect("/new"))

// path.JSON() — handler MUST return Response
path.JSON("/api/health", (ctx) => Response.json({ status: "ok" }))
path.JSON("/api/health", (ctx) => <JSX />)  // TS error: Type 'Element' is not assignable to 'Response'
```

```typescript
// Type definitions
type ResponseHandler<TParams, TEnv> = (ctx: ResponseHandlerContext<TParams, TEnv>) =>
  Response | Promise<Response>;

// vs regular handler
type Handler<TParams, TEnv> = (ctx: HandlerContext<TParams, TEnv>) =>
  ReactNode | Response | Promise<ReactNode | Response>;
```

**`ResponseHandlerContext`** — lighter context without RSC-specific features:

```typescript
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams;
  env: TEnv;
  href: HrefFunction;
  // No ctx.use() — no loaders
  // No ctx.res — handler creates its own Response
}
```

**`urls.JSON()` builder helpers** — restricted to what makes sense for response routes:

```typescript
// Regular urls() passes all helpers
urls(({ path, layout, parallel, loader, loading, cache, include }) => [...])

// urls.JSON() only passes response-compatible helpers
urls.JSON(({ path, include, cache }) => [...])
//         ^^^^^^^^^^^^^^^^^^^^^^^^^^
//         No layout, parallel, loader, loading, intercept
```

| Helper | `urls()` | `urls.JSON()` | Why |
|--------|----------|---------------|-----|
| `path` / `path.JSON` | YES | YES | Register routes |
| `include` | YES | YES | Compose sub-modules |
| `cache` | YES | YES | Response-level caching |
| `layout` | YES | NO | No React tree to wrap |
| `loading` | YES | NO | No Suspense boundaries |
| `parallel` | YES | NO | No parallel segments |
| `loader` | YES | NO | No segment data loading |
| `intercept` | YES | NO | No soft navigation intercepts |
| `when` | YES | NO | Intercept condition (RSC-only) |

**`path.JSON()` children** — only `cache()` is valid:

```typescript
// Valid: cache wrapper around a response route
cache({ ttl: 300 }, () => [
  path.JSON("/api/products", productsHandler, { name: "products" }),
])

// Invalid: loading/parallel/layout around response routes
layout(<ApiLayout />, () => [         // TS error
  path.JSON("/api/health", handler),
])
```

### Implementation

```typescript
const RESPONSE_TYPE = Symbol.for("rangojs.responseType");

// --- Type definitions ---

// Restricted helpers for urls.JSON() — no layout, parallel, loader, loading, intercept, when
interface ResponsePathHelpers<TEnv> {
  path: ResponsePathFn<TEnv>;     // handler must return Response
  include: IncludeFn<TEnv>;
  cache: CacheFn;
  // Excluded: layout, parallel, loader, loading, intercept, when
}

// Handler that must return Response (not ReactNode)
type ResponseHandler<TParams, TEnv> = (
  ctx: ResponseHandlerContext<TParams, TEnv>
) => Response | Promise<Response>;

// Lighter context — no ctx.use(), no segment-specific APIs
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams;
  env: TEnv;
  href: HrefFunction;
}

// --- Tag function implementations ---

// urls.JSON() passes restricted helpers and marks all routes
urls.JSON = <TEnv>(
  builder: (helpers: ResponsePathHelpers<TEnv>) => TItems
): UrlPatterns<TEnv> => {
  // Only pass { path, include, cache } — not the full set
  const patterns = urls((allHelpers) => {
    const { path, include, cache } = allHelpers;
    return builder({ path, include, cache });
  });
  patterns[RESPONSE_TYPE] = "application/json";
  return patterns;
};

// path.JSON() narrows handler to ResponseHandler
path.JSON = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, { ...options, [RESPONSE_TYPE]: "application/json" });

path.TEXT = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, { ...options, [RESPONSE_TYPE]: "text/plain" });

path.ANY = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, { ...options, [RESPONSE_TYPE]: "*" });

// include.JSON() overrides response type on mounted patterns
include.JSON = (prefix, patterns, options?) =>
  include(prefix, patterns, { ...options, [RESPONSE_TYPE]: "application/json" });

// href.JSON() returns Link-ready props
href.JSON = (path: ValidPaths, mount?: string) =>
  ({ to: href(path, mount), "data-external": true });

href.ANY = (path: ValidPaths, mount?: string) =>
  ({ to: href(path, mount), "data-external": true });
```

### Response type resolution order

When multiple levels declare a response type, specificity wins:

1. `path.JSON()` on the route itself (most specific)
2. `include.JSON()` on the mounting include (override)
3. `urls.JSON()` on the UrlPatterns (module default)
4. No response type = RSC route (default)

A `path.TEXT()` inside `urls.JSON()` patterns serves text, not JSON. The module default is a fallback, not a mandate.

When `path()` or `include()` processes options, it checks for `options[RESPONSE_TYPE]`. When `include()` mounts `UrlPatterns`, it checks `patterns[RESPONSE_TYPE]` for the module-level default. Either way, the response type propagates to the trie.

## Server-Side: Short-Circuit at the Trie

The key architectural insight: **the trie already matches the route before anything else happens**. If the response type is available at the trie level, we can short-circuit before manifest loading, segment resolution, or any RSC machinery.

### Current request flow (no response type)

```
Request
  -> findMatch(pathname)          -- trie match, returns RouteMatchResult
  -> loadManifest()               -- loads EntryData (handler, loaders, middleware...)
  -> resolveSegments()            -- walks entry tree, calls handlers, builds React tree
  -> handleHandlerResult()        -- if handler returns Response: throws it
  -> renderToReadableStream()     -- serializes React tree to Flight
  -> catch block                  -- catches thrown Response
```

### Proposed flow (with response type)

```
Request
  -> findMatch(pathname)          -- trie match, RouteMatchResult now has responseType
  -> [SHORT-CIRCUIT] responseType detected:
      -> loadManifest()           -- still needed for route middleware + handler
      -> Route middleware         -- auth, CORS, etc. still run
      -> Call handler directly    -- handler(ctx) -> Response
      -> Return Response          -- done. No segments, no Flight, no throw/catch
  -> [NO RESPONSE TYPE] Existing RSC pipeline unchanged
```

### Where response type lives in the trie

The trie stores `RouteEntry` objects (`types.ts:952`). When `path()` registers a route with a response type constant, it propagates to the trie node so `findMatch()` can include it in `RouteMatchResult`:

```typescript
// types.ts - RouteMatchResult gets responseType field
export interface RouteMatchResult<TEnv = any> {
  entry: RouteEntry<TEnv>;
  routeKey: string;
  params: Record<string, string>;
  // ...existing fields
  responseType?: string;  // From path.JSON etc., available at match time
}
```

The short-circuit check happens in `coreRequestHandler()` right after `previewMatch()`:

```typescript
// handler.ts - coreRequestHandler()
const preview = await router.previewMatch(request, env);

if (preview?.responseType) {
  const executeHandler = async () => {
    const ctx = router.createContext(request, env, url, routeMap, preview.routeName);
    const result = await preview.handler(ctx);
    if (result instanceof Response) return result;
    throw new Error(
      `Route "${preview.routeName}" is marked as ${preview.responseType} but handler did not return a Response`
    );
  };

  if (preview.routeMiddleware?.length) {
    return executeMiddleware(preview.routeMiddleware, request, env, variables, executeHandler);
  }
  return executeHandler();
}
```

### What gets skipped

For a response-type route, the following never execute:

| Operation | File | Cost | Skipped? |
|-----------|------|------|----------|
| `loadManifest()` | manifest.ts:42 | Moderate (runs entire route tree registration) | YES -- handler stored on trie |
| `collectRouteMiddleware()` | middleware.ts:765 | Cheap (walks manifest tree) | YES |
| `coreRequestHandlerInner()` | handler.ts:323 | Entry point for RSC logic | YES |
| `handleRscRendering()` | handler.ts:1015 | Expensive (segment resolution + React tree) | YES |
| `resolveSegments()` | segment-resolution.ts | Expensive (walks entry tree, calls handlers) | YES |
| `handleHandlerResult()` | segment-resolution.ts:46 | The throw/catch mechanism | YES |
| `renderToReadableStream()` | handler.ts:1154 | Expensive (Flight serialization) | YES |
| Version mismatch detection | handler.ts:338 | Cheap but not relevant | YES |
| `isPartial` / `_rsc_partial` | handler.ts:330 | Not relevant for non-Flight | YES |

### Where the optimization happens

`previewMatch()` (router.ts:1751) stays -- it provides `findMatch()` + `loadManifest()` + route middleware collection. This is necessary because middleware (auth, CORS, rate limiting) must run for API routes. `loadManifest()` is moderate cost on first request but cached per-isolate after that.

The optimization is everything AFTER `previewMatch()`. Today, response routes enter `coreRequestHandlerInner()` which runs segment resolution, React tree building, Flight serialization, and the throw/catch dance. All of that is skipped.

### Minimal code path

```
Current (response route today):
  App middleware                    → runs (wraps everything)
  previewMatch                     → findMatch + loadManifest + collectRouteMiddleware
  Route middleware                 → runs (via executeMiddleware)
  coreRequestHandlerInner          → isPartial, version checks, action checks
  handleRscRendering               → segment resolution (EXPENSIVE)
  resolveSegments                  → walks entry tree, calls handlers (EXPENSIVE)
  handleHandlerResult              → handler returns Response, throws it
  renderToReadableStream           → Flight serialization (EXPENSIVE, never used)
  catch(Response)                  → catches thrown Response
  return Response

Optimized (response-type route):
  App middleware                    → runs (wraps everything)
  previewMatch                     → findMatch + loadManifest (cached) + collectRouteMiddleware
  Route middleware                 → runs (via executeMiddleware)
  handler(ctx)                     → direct call, returns Response
  return Response                  → done

Skipped:
  coreRequestHandlerInner          → entire RSC inner handler
  handleRscRendering               → segment resolution + React tree
  resolveSegments                  → entry tree walking
  handleHandlerResult              → throw/catch mechanism
  renderToReadableStream           → Flight serialization
```

Future optimization: store handler + middleware references directly on the trie node at registration time to skip `loadManifest()` entirely. This would make response routes O(trie match + handler call) with zero async overhead on any request. Not needed for v1 since manifest is cached per-isolate.

## Client-Side: Auto-External Links

`href.JSON()` / `href.ANY()` return `{ to: url, "data-external": true }` which spreads directly into `<Link>`. The Link does a hard navigation -- no Flight fetch, no wasted round-trip.

```typescript
<Link {...href.JSON("/api/health")}>Check Health</Link>
// renders: <a href="/api/health" data-external="true">Check Health</a>
```

For the case where a developer uses plain `href()` instead of `href.JSON()` on a Link pointing to a response-type route, the `X-RSC-Reload` fallback from PR #140 still catches it. The server sees the partial request, the trie short-circuit returns the Response directly (not wrapped in Flight), and the client gets `X-RSC-Reload` to hard-navigate.

## What Changes

| File | Change |
|------|--------|
| `src/urls.ts` | Add `RESPONSE_TYPE` symbol, add `.JSON`/`.TEXT`/`.ANY` tag functions to `path`/`include` |
| `src/server/context.ts` | Add `responseType` field to route `EntryData` |
| `src/types.ts` | Add `responseType` to `RouteMatchResult` so trie match carries it |
| `src/router/match-api.ts` | Extend `previewMatch()` to return `responseType` + handler |
| `src/rsc/handler.ts` | Add short-circuit in `coreRequestHandler()` before RSC pipeline |
| `src/href-client.ts` | Add `.JSON`/`.TEXT`/`.ANY` tag functions to `href` (return `{ to, data-external }`) |
| `src/browser/react/Link.tsx` | No change needed -- `data-external` already works |

## What Doesn't Change

- `handleHandlerResult()` -- still throws Responses for non-typed routes (backward compat)
- `X-RSC-Reload` fallback -- stays for `path()` routes without response type that return Response
- `href()` return type -- still a string
- `<Link>` component logic -- `data-external` is already handled
- Existing route definitions -- no response type = JSX route, same as today
- Middleware execution -- response-type routes still go through app + route middleware

## Interaction with Existing Features

- **Caching**: Response-type routes bypass segment resolution, so segment caching doesn't apply. Response-level caching (e.g. Cloudflare Cache API) would work.
- **Prerendering**: Response-type routes cannot be prerendered (no segments to store). Should error at build time if attempted.
- **Loaders**: Not applicable -- response-type routes don't have segments, so no loader execution.
- **Error boundaries**: Not applicable -- response-type routes return Responses, not React trees.
- **Middleware**: Fully compatible -- both app-level and route-level middleware run before the handler.

## Response type inheritance

Three levels of declaration, from broadest to most specific:

```typescript
// 1. Module level -- urls.JSON() sets the default for all routes
export const apiPatterns = urls.JSON(({ path }) => [
  path("/health", healthHandler, { name: "health" }),      // inherits JSON
  path("/products", productsHandler, { name: "products" }), // inherits JSON
  path.TEXT("/export.csv", csvHandler, { name: "export" }), // overrides to TEXT
]);

// 2. Mount level -- include.JSON() overrides whatever the patterns declare
include.JSON("/legacy", legacyPatterns, { name: "legacy" })

// 3. Route level -- path.JSON() on individual routes (most specific)
path.JSON("/api/health", healthHandler, { name: "health" })
```

The consumer can mount API patterns transparently:

```typescript
// apiPatterns was defined with urls.JSON() -- consumer doesn't need to know
include("/api", apiPatterns, { name: "api" })
```

## Implementation Plan

### Phase 1: Core — tag functions + server-side short-circuit

1. **Add `RESPONSE_TYPE` symbol and tag functions to `urls.ts`**
   - `path.JSON()`, `path.TEXT()`, `path.ANY()` with `ResponseHandler` type
   - `include.JSON()`, `include.TEXT()`, `include.ANY()`
   - `urls.JSON()`, `urls.TEXT()`, `urls.ANY()` with `ResponsePathHelpers`
   - `ResponseHandlerContext` (lighter, no `ctx.use()`)

2. **Add `responseType` to `EntryData`** (`server/context.ts`)
   - Route entries carry `responseType?: string`

3. **Propagate `responseType` through the trie** (`types.ts`)
   - `RouteMatchResult.responseType`
   - `include()` inheritance: `urls.JSON()` default → `include.JSON()` override → `path.JSON()` specific

4. **Extend `previewMatch()`** (`router/match-api.ts`)
   - Return `responseType` and `handler` when matched route has a response type

5. **Add short-circuit in `coreRequestHandler()`** (`rsc/handler.ts`)
   - After `previewMatch()`: if `responseType`, call handler directly, skip RSC pipeline
   - Still run app + route middleware

6. **Add `href.JSON()`, `href.TEXT()`, `href.ANY()` to client href** (`href-client.ts`)
   - Returns `{ to, "data-external": true }` for `<Link>` spread

### Phase 2: Example app — `cloudflare-basic`

7. **Add API module** (`examples/cloudflare-basic/src/api/`)
   - `urls.tsx` — `urls.JSON()` with several endpoints:
     - `path("/health", ...)` — simple health check, returns `{ status: "ok" }`
     - `path("/products", ...)` — returns JSON array
     - `path("/products/:id", ...)` — returns JSON object with params
   - `handlers.ts` — handler functions for the API routes

8. **Mount in main urls** (`examples/cloudflare-basic/src/urls.tsx`)
   - `include("/api", apiPatterns, { name: "api" })` — transparent mounting
   - Add nav link with `href.JSON()` for testing client-side navigation

9. **Add mixed response route** (`examples/cloudflare-basic/src/urls.tsx`)
   - `path.TEXT("/robots.txt", ...)` — alongside JSX routes
   - Shows per-route response type in a mixed module

### Phase 3: E2E tests

10. **Direct visit tests** (`e2e/response-routes.test.ts`)
    - `GET /api/health` → 200, `Content-Type: application/json`, body is `{ status: "ok" }`
    - `GET /api/products` → 200, JSON array
    - `GET /api/products/123` → 200, JSON with params
    - `GET /robots.txt` → 200, `Content-Type: text/plain`

11. **Client-side navigation tests** (`e2e/response-routes.test.ts`)
    - Click `<Link {...href.JSON("/api/health")}>` → hard navigation, shows JSON
    - Click `<Link {...href.ANY("/robots.txt")}>` → hard navigation, shows text
    - Verify no Flight request is made (data-external skips partial fetch)

12. **Fallback tests** (`e2e/response-routes.test.ts`)
    - Click a plain `<Link to={href("/api/health")}>` (without `href.JSON`) → X-RSC-Reload fallback still works (PR #140)
    - Verify console.warn about missing `data-external`

13. **Middleware tests** (`e2e/response-routes.test.ts`)
    - Add a route middleware (e.g. auth check) to an API route
    - Verify middleware runs before handler on response-type routes
    - Verify middleware can reject with 401 Response

14. **`include()` inheritance tests** (`e2e/response-routes.test.ts`)
    - `urls.JSON()` module mounted with plain `include()` — all routes return JSON
    - Override: `path.TEXT()` inside `urls.JSON()` module — serves text
    - `include.JSON()` override — forces JSON on non-typed patterns

15. **TypeScript compile tests** (`e2e/response-routes-types.test.ts` or inline)
    - Verify `path.JSON()` with JSX handler fails type check
    - Verify `urls.JSON()` builder doesn't receive `layout`, `parallel`, etc.
    - Could use `tsc --noEmit` or `@ts-expect-error` assertions

16. **Build mode tests** (`e2e/response-routes.test.ts`)
    - Run the same direct visit + client-side nav tests in build/preview mode
    - Verify response routes work after production build

### Phase 4: Performance investigation

17. **Baseline measurements**
    - Instrument `coreRequestHandler()` with `performance.now()` markers
    - Measure response-type route latency vs regular RSC route latency
    - Measure: trie match time, `previewMatch()` time, `loadManifest()` time (cached vs cold), middleware execution time, total handler time
    - Compare against a plain `fetch()` handler (no framework) as lower bound

18. **Identify overhead hotspots**
    - Profile `loadManifest()` cost for response routes — is the cached path truly cheap?
    - Profile `collectRouteMiddleware()` + `traverseBack()` — is the manifest tree walk justified?
    - Measure AsyncLocalStorage / Store setup overhead for response routes
    - Check if `createHandlerContext()` does unnecessary work for `ResponseHandlerContext`
    - Measure header merging (`createResponseWithMergedHeaders()`) cost

19. **Track overhead log**
    - Maintain a running list of observed overhead during development
    - Document each item with: what it is, measured cost, whether it's avoidable
    - Use this as input for future optimization (Phase 6)

20. **Optimization targets**
    - If `loadManifest()` cached path is >1ms: investigate storing handler + middleware on trie directly
    - If Store/AsyncLocalStorage setup is measurable: investigate skipping for response routes
    - If `createHandlerContext()` is measurable: use `ResponseHandlerContext` (lighter, no loader setup)
    - If total overhead is >5ms above raw handler time: flag for deeper optimization

### Phase 5: Verification

21. **Run full test suite** — all existing e2e tests pass (no regressions)
22. **Run new response-routes tests** — both dev and build modes
23. **TypeScript check** — `pnpm typecheck` passes
24. **Performance check** — response-type routes meet latency targets from Phase 4

### Phase 6: Optimization pass (based on Phase 4 findings)

25. **Address items from the overhead log** — fix anything flagged as avoidable
26. **Evaluate trie-level handler storage** — if `loadManifest()` is a bottleneck, store handler + middleware references directly on trie node at registration time, eliminating manifest loading entirely for response routes
27. **Evaluate lighter context** — if `createHandlerContext()` overhead is measurable, implement `ResponseHandlerContext` as a separate code path (no loader setup, no cache scope, no segment tracking)

## Open Questions

1. Should the framework validate that the Response content-type matches the declared type (e.g. `path.JSON` but Response has `text/plain`)? Or is the type purely a routing signal?
2. Should there be a `path.HTML` for server-rendered HTML pages that aren't RSC? (e.g. legacy pages, static HTML)
3. Naming: `path.JSON` vs `path.json` (lowercase)?
4. Should `cache()` work differently for response routes? (Response-level caching vs segment caching)
