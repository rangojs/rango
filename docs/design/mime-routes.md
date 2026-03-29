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
  path.json("/api/data", dataHandler, { name: "apiData" }),
  path.json("/api/webhook", webhookHandler, { name: "webhook" }),
]);

// consumer app -- mounts everything, doesn't need to know which routes are JSX vs API
include("/vendor", vendorPatterns, { name: "vendor" });
```

The consumer doesn't need to know which routes are JSX and which are API -- the framework handles both correctly. `ctx.reverse("vendor.apiData")` resolves the URL from anywhere.

## Supported MIME Types

| Tag       | MIME type           | Use case                                        |
| --------- | ------------------- | ----------------------------------------------- |
| `.json`   | `application/json`  | REST APIs, JSON endpoints                       |
| `.text`   | `text/plain`        | `robots.txt`, plain text responses              |
| `.html`   | `text/html`         | Non-RSC server-rendered HTML, legacy pages      |
| `.xml`    | `application/xml`   | RSS feeds, SOAP endpoints, sitemaps             |
| `.image`  | `image/*`           | Dynamic image generation                        |
| `.stream` | `text/event-stream` | Server-Sent Events (SSE)                        |
| `.any`    | `*`                 | Anything non-RSC (binary, custom content types) |

## API Design

### Tag functions

`urls`, `path`, and `href` get typed variants as methods: `.json`, `.text`, `.html`, `.xml`, `.image`, `.stream`, `.any`. Same signature as the base function, but marks the route as non-RSC.

```typescript
urls.json; // urls() where all routes serve JSON (module-level declaration)
urls.text;
urls.html;
urls.xml;
urls.stream;
urls.any;

path.json; // path() that returns application/json
path.text; // path() that returns text/plain
path.html; // path() that returns text/html
path.xml; // path() that returns application/xml
path.image; // path() that returns image/*
path.stream; // path() that returns text/event-stream
path.any; // path() that returns anything but RSC

href.json; // href() that returns Link props with data-external
href.text;
href.html;
href.xml;
href.stream;
href.any;
```

Note: `include()` does **not** have response type tags. Response typing happens at the definition site via `urls.json()`, `path.json()`, etc. -- not at the mount site. This avoids a type-level gap where `include.json()` would tag routes at runtime but lose response data type inference.

### Route definition

**Module-level: `urls.json()` -- the module declares its own response type**

```typescript
// api-module/urls.tsx -- author knows all routes here are JSON
export const apiPatterns = urls.json(({ path }) => [
  path("/health", healthHandler, { name: "health" }),
  path("/products", productsHandler, { name: "products" }),
  path("/products/:id", productDetailHandler, { name: "productDetail" }),
]);

// consumer -- plain include(), response type comes from the patterns
include("/api", apiPatterns, { name: "api" });
```

**Per-route: `path.json()` -- mixed modules with some API routes**

```typescript
urls(({ path, include }) => [
  // JSON API endpoint alongside JSX routes
  path.json("/api/health", healthHandler, { name: "health" }),

  // Plain text route
  path.text("/robots.txt", robotsHandler, { name: "robots" }),

  // SSE streaming endpoint
  path.stream("/api/events", sseHandler, { name: "events" }),

  // XML sitemap
  path.xml("/sitemap.xml", sitemapHandler, { name: "sitemap" }),

  // Module declares its own type -- consumer doesn't need to know
  include("/api", apiPatterns, { name: "api" }),

  // Regular JSX routes -- plain path(), default behavior
  path("/", HomePage, { name: "home" }),
]);
```

### Client-side usage

`href.json()` returns an object that spreads directly into `<Link>` props:

```typescript
// href.json("/api/health") returns { to: "/api/health", "data-external": true }

// Client component
<Link {...href.json("/api/health")}>Check Health</Link>

// Server component with named route
<Link {...href.json(ctx.reverse("api.health"))}>Check Health</Link>

// any -- don't care about specific type, just "not RSC"
<Link {...href.any("/api/health")}>Check Health</Link>

// Regular RSC link -- plain href(), no tag
<Link to={href("/about")}>About</Link>
```

### Auto-wrap: plain return values

Handlers can return plain values instead of constructing `Response` objects. The framework auto-wraps the return value based on the MIME tag:

| Tag       | Handler can return      | Auto-wrap behavior                                             |
| --------- | ----------------------- | -------------------------------------------------------------- |
| `.json`   | `JsonValue \| Response` | `JSON.stringify(result)` with `application/json;charset=utf-8` |
| `.text`   | `string \| Response`    | `String(result)` with `text/plain;charset=utf-8`               |
| `.html`   | `string \| Response`    | `String(result)` with `text/html;charset=utf-8`                |
| `.xml`    | `string \| Response`    | `String(result)` with `application/xml;charset=utf-8`          |
| `.image`  | `Response` only         | No auto-wrap (binary data)                                     |
| `.stream` | `Response` only         | No auto-wrap (streaming)                                       |
| `.any`    | `Response` only         | No auto-wrap                                                   |

When the handler returns a `Response` directly, it passes through unchanged (status code, headers preserved). This allows full control when needed:

```typescript
// Auto-wrapped: plain object -> JSON response with 200
path.json("/products", (ctx) => products);

// Pass-through: Response returned directly for custom status/headers
path.json("/products/:id", (ctx) => {
  const product = findProduct(ctx.params.id);
  if (!product) return new Response("Not found", { status: 404 });
  return product; // auto-wrapped as JSON
});
```

### JSON response envelope

JSON response routes (`path.json`, `urls.json`) wrap results in a discriminated union envelope:

```typescript
type ResponseEnvelope<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: ResponseError };

interface ResponseError {
  message: string;
  code?: string;
  type?: string;
  stack?: string; // dev only
}
```

Success: `{ data: T }`. Error: `{ error: { message, code?, type? } }` with appropriate HTTP status.

Errors are handled automatically -- handlers throw `RouterError` for structured errors:

```typescript
path.json("/products/:id", (ctx) => {
  const product = findProduct(ctx.params.id);
  if (!product) {
    throw new RouterError("NOT_FOUND", "Product not found", { status: 404 });
  }
  return product; // wrapped as { data: product }
});
// On throw: { error: { message: "Product not found", code: "NOT_FOUND" } } with 404 status
```

`RouterError` messages are always exposed (developer-crafted). Generic `Error` messages are hidden in production (`"Internal Server Error"`).

Non-JSON response routes also catch errors and return plain text `Response` with the appropriate status code.

### Client-side type guard

`isResponseError<T>()` narrows a `ResponseEnvelope<T>` to the error branch:

```typescript
import { isResponseError, type ResponseEnvelope } from "@rangojs/router/client";

const result: ResponseEnvelope<Product> = await fetch(url).then((r) =>
  r.json(),
);
if (isResponseError(result)) {
  console.log(result.error.message, result.error.code);
  return;
}
result.data.name; // fully typed as Product
```

### Typed response lookup

Two mechanisms for extracting response types at the type level:

- **`RouteResponse<typeof patterns, "name">`** -- by route name, scoped to a `UrlPatterns` instance
- **`PathResponse<"/path">`** -- by URL pattern, global via `RegisteredRoutes`

```typescript
// Scoped (from UrlPatterns)
type Health = RouteResponse<typeof apiPatterns, "health">;
// ResponseEnvelope<{ status: string; timestamp: number }>

// Global (from RegisteredRoutes after createRouter().routes())
type Health = PathResponse<"/api/health">;
// ResponseEnvelope<{ status: string; timestamp: number }>
```

### TypeScript constraints

Response-type routes have narrower types than JSX routes. This prevents misuse at compile time.

**Handler return type** — per-tag types enforce what values are allowed:

```typescript
// Regular path() — handler can return JSX or Response
path("/about", (ctx) => <AboutPage />)
path("/old", (ctx) => Response.redirect("/new"))

// path.json() — handler can return JSON values or Response
path.json("/api/health", (ctx) => ({ status: "ok" }))       // plain object, auto-wrapped
path.json("/api/health", (ctx) => Response.json({ ... }))    // Response, pass-through
path.json("/api/health", (ctx) => <JSX />)  // TS error: Type 'Element' is not assignable

// path.text() — handler can return string or Response
path.text("/robots.txt", (ctx) => "User-agent: *\nDisallow:")
path.text("/robots.txt", (ctx) => new Response("...", { headers: ... }))
```

```typescript
// Type definitions per MIME tag
type JsonResponseHandler<TParams, TEnv> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => JsonValue | Response | Promise<JsonValue | Response>;

type TextResponseHandler<TParams, TEnv> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => string | Response | Promise<string | Response>;

type ResponseHandler<TParams, TEnv> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => Response | Promise<Response>;

// vs regular handler
type Handler<TParams, TEnv> = (
  ctx: HandlerContext<TParams, TEnv>,
) => ReactNode | Response | Promise<ReactNode | Response>;
```

**`ResponseHandlerContext`** — lighter context without RSC-specific features:

```typescript
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams;
  env: TEnv; // platform bindings from createRouter<TBindings>()
  searchParams: URLSearchParams; // system params filtered
  url: URL;
  pathname: string;
  reverse: ReverseFunction;
  // No ctx.use() — no loaders
  // No ctx.res — handler creates its own Response
  // No ctx.set() — response routes can read middleware variables via ctx.get()
}
```

**`urls.json()` builder helpers** — restricted to what makes sense for response routes:

```typescript
// Regular urls() passes all helpers
urls(({ path, layout, parallel, loader, loading, cache, include }) => [...])

// urls.json() only passes response-compatible helpers
urls.json(({ path, include, cache }) => [...])
//         ^^^^^^^^^^^^^^^^^^^^^^^^^^
//         No layout, parallel, loader, loading, intercept
```

| Helper               | `urls()` | `urls.json()` | Why                            |
| -------------------- | -------- | ------------- | ------------------------------ |
| `path` / `path.json` | YES      | YES           | Register routes                |
| `include`            | YES      | YES           | Compose sub-modules            |
| `cache`              | YES      | YES           | Response-level caching         |
| `layout`             | YES      | NO            | No React tree to wrap          |
| `loading`            | YES      | NO            | No Suspense boundaries         |
| `parallel`           | YES      | NO            | No parallel segments           |
| `loader`             | YES      | NO            | No segment data loading        |
| `intercept`          | YES      | NO            | No soft navigation intercepts  |
| `when`               | YES      | NO            | Intercept condition (RSC-only) |

**`path.json()` children** — only `cache()` is valid:

```typescript
// Valid: cache wrapper around a response route
cache({ ttl: 300 }, () => [
  path.json("/api/products", productsHandler, { name: "products" }),
])

// Invalid: loading/parallel/layout around response routes
layout(<ApiLayout />, () => [         // TS error
  path.json("/api/health", handler),
])
```

### Implementation

```typescript
const RESPONSE_TYPE = Symbol.for("rangojs.responseType");

// --- MIME type map ---

const MIME_TYPES = {
  json: "application/json",
  text: "text/plain",
  html: "text/html",
  xml: "application/xml",
  image: "image/*",
  stream: "text/event-stream",
  any: "*",
} as const;

type MimeTag = keyof typeof MIME_TYPES;

// --- Type definitions ---

// Restricted helpers for urls.json() — no layout, parallel, loader, loading, intercept, when
interface ResponsePathHelpers<TEnv> {
  path: ResponsePathFn<TEnv>; // handler must return Response
  include: IncludeFn<TEnv>;
  cache: CacheFn;
  // Excluded: layout, parallel, loader, loading, intercept, when
}

// Handler that must return Response (not ReactNode)
type ResponseHandler<TParams, TEnv> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => Response | Promise<Response>;

// Lighter context — no ctx.use(), no segment-specific APIs
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams;
  env: TEnv;
  reverse: ReverseFunction;
}

// --- Tag function implementations ---

// Helper to create tag functions for each MIME type
function createMimeTag<TFn extends Function>(
  baseFn: TFn,
  tagName: MimeTag,
  mimeType: string,
) {
  // Implementation varies per base function (path, urls, include, href)
}

// urls.json() passes restricted helpers and marks all routes
urls.json = <TEnv>(
  builder: (helpers: ResponsePathHelpers<TEnv>) => TItems,
): UrlPatterns<TEnv> => {
  const patterns = urls((allHelpers) => {
    const { path, include, cache } = allHelpers;
    return builder({ path, include, cache });
  });
  patterns[RESPONSE_TYPE] = MIME_TYPES.json;
  return patterns;
};

// All MIME tags on path -- each narrows handler to ResponseHandler
path.json = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.json,
  });

path.text = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.text,
  });

path.html = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.html,
  });

path.xml = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.xml,
  });

path.image = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.image,
  });

path.stream = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.stream,
  });

path.any = (pattern, handler: ResponseHandler, options?) =>
  path(pattern, handler as any, {
    ...options,
    [RESPONSE_TYPE]: MIME_TYPES.any,
  });

// All MIME tags on href -- each returns Link-ready props
href.json = (path: ValidPaths, mount?: string) => ({
  to: href(path, mount),
  "data-external": true,
});

href.text = (path: ValidPaths, mount?: string) => ({
  to: href(path, mount),
  "data-external": true,
});

// ... same pattern for href.html, href.xml, href.stream, href.any
```

### Response type resolution order

When multiple levels declare a response type, specificity wins:

1. `path.json()` on the route itself (most specific)
2. `urls.json()` on the UrlPatterns (module default)
3. No response type = RSC route (default)

A `path.text()` inside `urls.json()` patterns serves text, not JSON. The module default is a fallback, not a mandate.

When `path()` processes options, it checks for `options[RESPONSE_TYPE]`. When `urls.json()` sets a module-level default, child `path()` calls inherit it via context. Either way, the response type propagates to the trie.

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
  responseType?: string; // From path.json etc., available at match time
}
```

The short-circuit check happens in `coreRequestHandler()` right after `previewMatch()`:

```typescript
// handler.ts - coreRequestHandler()
const preview = await router.previewMatch(request, env);

if (preview?.responseType) {
  const executeHandler = async () => {
    const ctx = router.createContext(
      request,
      env,
      url,
      routeMap,
      preview.routeName,
    );
    const result = await preview.handler(ctx);
    if (result instanceof Response) return result;
    throw new Error(
      `Route "${preview.routeName}" is marked as ${preview.responseType} but handler did not return a Response`,
    );
  };

  if (preview.routeMiddleware?.length) {
    return executeMiddleware(
      preview.routeMiddleware,
      request,
      env,
      variables,
      executeHandler,
    );
  }
  return executeHandler();
}
```

### What gets skipped

For a response-type route, the following never execute:

| Operation                    | File                     | Cost                                           | Skipped?                      |
| ---------------------------- | ------------------------ | ---------------------------------------------- | ----------------------------- |
| `loadManifest()`             | manifest.ts:42           | Moderate (runs entire route tree registration) | YES -- handler stored on trie |
| `collectRouteMiddleware()`   | middleware.ts:765        | Cheap (walks manifest tree)                    | YES                           |
| `coreRequestHandlerInner()`  | handler.ts:323           | Entry point for RSC logic                      | YES                           |
| `handleRscRendering()`       | handler.ts:1015          | Expensive (segment resolution + React tree)    | YES                           |
| `resolveSegments()`          | segment-resolution.ts    | Expensive (walks entry tree, calls handlers)   | YES                           |
| `handleHandlerResult()`      | segment-resolution.ts:46 | The throw/catch mechanism                      | YES                           |
| `renderToReadableStream()`   | handler.ts:1154          | Expensive (Flight serialization)               | YES                           |
| Version mismatch detection   | handler.ts:338           | Cheap but not relevant                         | YES                           |
| `isPartial` / `_rsc_partial` | handler.ts:330           | Not relevant for non-Flight                    | YES                           |

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

`href.json()` / `href.any()` return `{ to: url, "data-external": true }` which spreads directly into `<Link>`. The Link does a hard navigation -- no Flight fetch, no wasted round-trip.

```typescript
<Link {...href.json("/api/health")}>Check Health</Link>
// renders: <a href="/api/health" data-external="true">Check Health</a>
```

For the case where a developer uses plain `href()` instead of `href.json()` on a Link pointing to a response-type route, the `X-RSC-Reload` fallback from PR #140 still catches it. The server sees the partial request, the trie short-circuit returns the Response directly (not wrapped in Flight), and the client gets `X-RSC-Reload` to hard-navigate.

## What Changes

| File                         | Change                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/urls.ts`                | Add `RESPONSE_TYPE` symbol, `MIME_TYPES` map, add `.json`/`.text`/`.html`/`.xml`/`.image`/`.stream`/`.any` tag functions to `path`, `ResponseEnvelope`/`ResponseError` types, `RouterError` error class |
| `src/server/context.ts`      | Add `responseType` field to route `EntryData`                                                                                                                                                           |
| `src/types.ts`               | Add `responseType` to `RouteMatchResult` so trie match carries it                                                                                                                                       |
| `src/router/match-api.ts`    | Extend `previewMatch()` to return `responseType` + handler                                                                                                                                              |
| `src/rsc/handler.ts`         | Add short-circuit in `coreRequestHandler()` before RSC pipeline, JSON envelope wrapping, error handling for all response routes                                                                         |
| `src/href-client.ts`         | Add `.json`/`.text`/`.html`/`.xml`/`.stream`/`.any` tag functions to `href` (return `{ to, data-external }`), `PathResponse` type                                                                       |
| `src/client.tsx`             | Export `ResponseEnvelope`, `ResponseError`, `PathResponse`, `isResponseError()` type guard                                                                                                              |
| `src/browser/react/Link.tsx` | No change needed -- `data-external` already works                                                                                                                                                       |

## What Doesn't Change

- `handleHandlerResult()` -- still throws Responses for non-tagged routes (backward compat)
- `X-RSC-Reload` fallback -- stays for plain `path()` routes without response type that return Response
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

Two levels of declaration, from broadest to most specific:

```typescript
// 1. Module level -- urls.json() sets the default for all routes
export const apiPatterns = urls.json(({ path }) => [
  path("/health", healthHandler, { name: "health" }), // inherits json
  path("/products", productsHandler, { name: "products" }), // inherits json
  path.text("/export.csv", csvHandler, { name: "export" }), // overrides to text
]);

// 2. Route level -- path.json() on individual routes (most specific)
path.json("/api/health", healthHandler, { name: "health" });
```

The consumer can mount API patterns transparently:

```typescript
// apiPatterns was defined with urls.json() -- consumer doesn't need to know
include("/api", apiPatterns, { name: "api" });
```

## Implementation Plan

### Phase 1: Core — tag functions + server-side short-circuit

1. **Add `RESPONSE_TYPE` symbol, `MIME_TYPES` map, and tag functions to `urls.ts`**
   - `path.json()`, `path.text()`, `path.html()`, `path.xml()`, `path.image()`, `path.stream()`, `path.any()` with `ResponseHandler` type
   - `urls.json()`, `urls.text()`, `urls.html()`, `urls.xml()`, `urls.stream()`, `urls.any()` with `ResponsePathHelpers`
   - `ResponseHandlerContext` (lighter, with env bindings extraction, searchParams, url, pathname)
   - `ResponseEnvelope<T>`, `ResponseError`, `RouteResponse` types
   - `RouterError` class for structured error throwing

2. **Add `responseType` to `EntryData`** (`server/context.ts`)
   - Route entries carry `responseType?: string`

3. **Propagate `responseType` through the trie** (`types.ts`)
   - `RouteMatchResult.responseType`
   - Inheritance: `urls.json()` default → `path.json()` specific override

4. **Extend `previewMatch()`** (`router/match-api.ts`)
   - Return `responseType` and `handler` when matched route has a response type

5. **Add short-circuit in `coreRequestHandler()`** (`rsc/handler.ts`)
   - After `previewMatch()`: if `responseType`, call handler directly, skip RSC pipeline
   - JSON routes: try/catch with `{ data }` / `{ error }` envelope wrapping
   - Non-JSON routes: try/catch with plain text error Response
   - `RouterError` messages always exposed; generic `Error` hidden in production
   - Still run app + route middleware

6. **Add `href.json()`, `href.text()`, `href.html()`, `href.xml()`, `href.stream()`, `href.any()` to client href** (`href-client.ts`)
   - Returns `{ to, "data-external": true }` for `<Link>` spread

### Phase 2: Example app — `cloudflare-basic`

7. **Add API module** (`examples/cloudflare-basic/src/api/`)
   - `urls.tsx` — `urls.json()` with several endpoints:
     - `path("/health", ...)` — simple health check, returns `{ status: "ok" }`
     - `path("/products", ...)` — returns JSON array
     - `path("/products/:id", ...)` — returns JSON object with params
   - `handlers.ts` — handler functions for the API routes

8. **Mount in main urls** (`examples/cloudflare-basic/src/urls.tsx`)
   - `include("/api", apiPatterns, { name: "api" })` — transparent mounting
   - Add nav link with `href.json()` for testing client-side navigation

9. **Add mixed response routes** (`examples/cloudflare-basic/src/urls.tsx`)
   - `path.text("/robots.txt", ...)` — plain text alongside JSX routes
   - `path.xml("/sitemap.xml", ...)` — XML sitemap
   - `path.stream("/api/events", ...)` — SSE endpoint
   - Shows per-route response type in a mixed module

### Phase 3: E2E tests

10. **Direct visit tests** (`e2e/response-routes.test.ts`)
    - `GET /api/health` → 200, `Content-Type: application/json`, body is `{ status: "ok" }`
    - `GET /api/products` → 200, JSON array
    - `GET /api/products/123` → 200, JSON with params
    - `GET /robots.txt` → 200, `Content-Type: text/plain`
    - `GET /sitemap.xml` → 200, `Content-Type: application/xml`
    - `GET /api/events` → 200, `Content-Type: text/event-stream`

11. **Client-side navigation tests** (`e2e/response-routes.test.ts`)
    - Click `<Link {...href.json("/api/health")}>` → hard navigation, shows JSON
    - Click `<Link {...href.any("/robots.txt")}>` → hard navigation, shows text
    - Verify no Flight request is made (data-external skips partial fetch)

12. **Fallback tests** (`e2e/response-routes.test.ts`)
    - Click a plain `<Link to={href("/api/health")}>` (without `href.json`) → X-RSC-Reload fallback still works (PR #140)
    - Verify console.warn about missing `data-external`

13. **Middleware tests** (`e2e/response-routes.test.ts`)
    - Add a route middleware (e.g. auth check) to an API route
    - Verify middleware runs before handler on response-type routes
    - Verify middleware can reject with 401 Response

14. **`include()` inheritance tests** (`e2e/response-routes.test.ts`)
    - `urls.json()` module mounted with plain `include()` — all routes return JSON
    - Override: `path.text()` inside `urls.json()` module — serves text

15. **TypeScript compile tests** (`e2e/response-routes-types.test.ts` or inline)
    - Verify `path.json()` with JSX handler fails type check
    - Verify `urls.json()` builder doesn't receive `layout`, `parallel`, etc.
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

## Resolved Decisions

- **Naming**: lowercase (`path.json`, `href.text`, `urls.stream`) -- matches JS convention for methods
- **`path.html`**: yes, included for non-RSC server-rendered HTML pages
- **`path.xml`**: yes, included for RSS feeds, sitemaps, SOAP
- **`path.stream`**: yes, included for SSE endpoints

## Open Questions

1. Should the framework validate that the Response content-type matches the declared type (e.g. `path.json` but Response has `text/plain`)? Or is the type purely a routing signal?
2. Should `cache()` work differently for response routes? (Response-level caching vs segment caching)
