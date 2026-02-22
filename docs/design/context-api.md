# Context API Design

## Overview

All request-time handlers share a single base context (`RequestContext`) created after route matching. Each handler type receives a **view** of this context with capabilities narrowed based on execution semantics. Illegal operations produce TypeScript errors at compile time and throw at runtime.

The core principle: **what's guaranteed to execute determines what you can mutate.**

---

## Request Lifecycle

```
Request arrives
    |
Route matching (params, pathname, url extracted)
    |
Base context created (request props + empty var + response stub)
    |
Middleware executes (can set vars, headers, cookies)
    |
Segment resolution (handlers, parallels, intercepts, loaders)
    |
Response
```

---

## Base Context

Created once per request, right after route matching. Every handler type reads from this same source.

### Request properties (read-only, all handlers)

| Property | Type | Notes |
|---|---|---|
| `request` | `Request` | Original HTTP request |
| `url` | `URL` | Parsed URL (handlers get filtered, no `_rsc*` params) |
| `pathname` | `string` | URL pathname |
| `searchParams` | `URLSearchParams` | Always URLSearchParams (handlers get filtered) |
| `search` | `ResolveSearchSchema<TSearch>` / `{}` | Typed search params from route schema |
| `params` | typed `TParams` | Route parameters from pattern matching |
| `method` | `string` | HTTP method (GET, POST, etc.) |
| `env` | typed `TBindings` | Platform bindings (Cloudflare KV, D1, etc.) |

### Middleware state

| Property | Type | Notes |
|---|---|---|
| `get(key)` | typed `V[K]` | Read variables set by middleware |
| `set(key, value)` | typed | **Middleware only** -- set variables for downstream handlers |

### Response surface

| Property | Type | Notes |
|---|---|---|
| `res` | `Response` | Stub response, headers merged into final response |
| `headers` | `Headers` | Alias for `res.headers` |
| `header(name, value)` | `void` | Shorthand for `res.headers.set()` |
| `cookie(name)` | `string \| undefined` | Read cookie from request |
| `cookies()` | `Record<string, string>` | All request cookies |
| `setCookie(name, value, opts)` | `void` | Set response cookie |
| `deleteCookie(name, opts)` | `void` | Delete cookie |

---

## Capability Matrix

| Capability | Middleware | Handler / Layout / Parallel / Intercept | Loader | Action | Prerender |
|---|---|---|---|---|---|
| **Request props** | all | all | all | all | synthetic (from `getParams` URL) |
| `get` (read vars) | yes | yes | yes | yes | never |
| `set` (write vars) | **yes** | never | never | never | never |
| `res` / `headers` / cookies | yes | yes | never | yes | never |
| `use(loader)` | never | yes | yes | yes | never |
| `use(handle)` | never | yes | never | never | yes |
| `reverse` | scoped+global | scoped+global | global | global | never |
| `redirect` / `notFound` | yes | yes | yes | yes | never |
| `setLocationState` | -- | yes | never | yes | never |
| `theme` / `setTheme` | -- | yes | never | yes | never |
| `body` / `formData` | -- | -- | yes (fetchable) | yes | never |

---

## Design Rationale

### Why middleware is the only one with `set`

Middleware always executes, in order, on every request. If a handler, layout, or parallel calls `ctx.set("key", value)` and that segment is cached, on cache hit the handler never runs -- downstream code calling `ctx.get("key")` gets `undefined`. Non-deterministic. Restricting `set` to middleware eliminates this class of bugs.

### Why loaders can't touch the response

Loaders run in parallel and are memoized. If multiple loaders set headers concurrently, the result is a race condition. Loaders are pure data fetchers -- they read context and return data.

### Why loaders CAN redirect/notFound

Two kinds of response interaction:
- **Control flow** (redirect, notFound, throw) -- aborts everything, deterministic, only one wins
- **Decoration** (headers, cookies, handles) -- additive, races in parallel execution

A loader that discovers "this product moved" or "this data doesn't exist" needs to express that. Forcing redirect logic into middleware would require duplicating the data-fetching logic the loader already has.

### Why middleware has no `use`

Middleware is the setup layer -- it reads the request, validates, sets vars, and passes control. `use(loader)` would create two patterns for the same thing (fetch in middleware vs. fetch in loader). `use(handle)` doesn't make sense because middleware has no segment identity for handle data keying. Keeping middleware pure and focused on context setup.

### Why `reverse` scoping follows `include()` boundaries

`reverse` supports both global names (`"shop.products"`) and local dot-prefixed names (`".products"`). Local names resolve within the `include()` boundary where the handler or middleware is defined. This enables composability -- middleware inside an `include()` can reference local routes without knowing global names, and the entire `include()` can be remounted at a different path without breaking.

Loaders and actions use global-only resolution since they're standalone definitions outside route trees.

### Why actions have no `use(handle)`

Handles are keyed by segment identity (which segment in the tree pushed the data). Actions are standalone `"use server"` functions with no segment identity -- there's no segment to key against.

### Why `set` is a function, not property assignment

`ctx.get(key)` / `ctx.set(key, value)` instead of `ctx.var.key = value`. Functions can be typed as `never` per handler type to produce TS errors. Property assignment on `ctx.var` can't be restricted at the type level per-context without complex `Readonly` wrappers.

---

## Open Questions

### Intercepts and `use(handle)`

Intercepts only run on client-side navigation, not SSR. If an intercept pushes handle data, that data exists on client nav but not on initial page load -- inconsistent. Current table shows intercepts with `use(handle)` allowed (they are segments in the tree), but this inconsistency may warrant restricting it.

---

## Typing Strategy

One base context type, narrowed per handler type using conditional types and `never`:

```typescript
// Illegal operations typed as never -- TS error at compile time
// Runtime: throw Error("ctx.set() is not available in route handlers")

// Middleware -- full access
type MiddlewareCtx = BaseCtx & { set: SetFn };

// Handler -- no set
type HandlerCtx = BaseCtx & { set: never; use: UseFn };

// Loader -- read-only, no response surface
type LoaderCtx = Pick<BaseCtx, RequestProps> & { use: UseLoaderFn };
```

Exact type structure TBD during implementation.
