# Context API Design

## Overview

All request-time handlers share a single base context created after route matching. Each handler type receives a view of this context with capabilities narrowed based on execution semantics. Illegal operations produce TypeScript errors at compile time and throw at runtime.

Core principle: **what is guaranteed to execute determines what you can mutate.**

## Request Lifecycle

```
Request -> Route matching -> Base context created -> Middleware -> Segment resolution -> Response
```

The base context is created once per request right after route matching. It holds request properties, an empty variables map, and a response stub. Middleware populates variables and may set headers/cookies. Segment resolution (handlers, parallels, intercepts, loaders) reads from this context.

## Base Context

### Request properties (read-only)

- `request` -- original HTTP request
- `url` -- parsed URL (handlers receive filtered version without `_rsc*` system params)
- `pathname` -- URL pathname
- `searchParams` -- always `URLSearchParams` (handlers receive filtered version)
- `search` -- typed search params from route schema, `{}` when no schema defined
- `params` -- route parameters from pattern matching
- `method` -- HTTP method
- `env` -- platform bindings (typed via `RouterEnv`)

### Middleware variables

- `get(key)` -- read variables set by middleware (all handler types)
- `set(key, value)` -- write variables (middleware only)

### Response surface

- `res` -- stub response, headers merged into final response
- `headers` -- alias for `res.headers`
- `header(name, value)` -- shorthand for `res.headers.set()`
- `cookie(name)`, `cookies()` -- read request cookies
- `setCookie(name, value, opts)`, `deleteCookie(name, opts)` -- modify response cookies

## Capability Matrix

| Capability | Middleware | Handler / Layout / Parallel / Intercept | Loader | Action | Prerender |
|---|---|---|---|---|---|
| Request props | all | all | all | all | synthetic |
| `get` (read vars) | yes | yes | yes | yes | no |
| `set` (write vars) | yes | no | no | no | no |
| Response surface | yes | yes | no | yes | no |
| `use(loader)` | no | yes | yes | yes | no |
| `use(handle)` | no | yes | no | no | yes |
| `reverse` | scoped+global | scoped+global | global | global | no |
| `redirect` / `notFound` | yes | yes | yes | yes | no |
| `setLocationState` | -- | yes | no | yes | no |
| `theme` / `setTheme` | -- | yes | no | yes | no |
| `body` / `formData` | -- | -- | yes (fetchable) | yes | no |

## Design Rationale

### Middleware is the only handler type with `set`

Middleware always executes on every request. Handlers, layouts, parallels, and intercepts may be segment-cached. If a cached handler calls `ctx.set("key", value)`, on cache hit the handler never runs and downstream `ctx.get("key")` returns `undefined`. Restricting `set` to middleware eliminates this non-determinism.

### Loaders cannot touch the response

Loaders run in parallel and are memoized. Multiple loaders setting headers concurrently is a race condition. Loaders are pure data fetchers that read context and return data.

### Loaders can redirect and throw notFound

Control flow (redirect, notFound, throw) aborts the request deterministically -- only one wins. This is distinct from response decoration (headers, cookies, handles) which is additive and races under parallel execution. A loader that discovers moved or missing data needs to express that without duplicating logic in middleware.

### Middleware has no `use`

Middleware is the setup layer. `use(loader)` would duplicate the existing pattern of fetching data in middleware and calling `ctx.set()`. `use(handle)` has no meaning because middleware has no segment identity to key handle data against.

### `reverse` scoping follows `include()` boundaries

Local dot-prefixed names (`.products`) resolve within the `include()` boundary where the handler or middleware is defined. This enables composability -- middleware inside an `include()` can reference local routes without knowing global names, and the `include()` can be remounted without breaking references. Loaders and actions resolve globally since they are standalone definitions outside route trees.

### Actions have no `use(handle)`

Handles are keyed by segment identity. Actions are standalone `"use server"` functions with no segment in the rendering tree to key against.

### `set` is a function, not property assignment

`ctx.get(key)` / `ctx.set(key, value)` rather than `ctx.var.key = value`. Functions can be typed as `never` per handler type to produce compile-time errors. Property assignment cannot be restricted at the type level per-context without complex wrappers.

## Open Questions

### Intercepts and `use(handle)`

Intercepts only run on client-side navigation, not on SSR. If an intercept pushes handle data, that data is present on client nav but absent on initial page load. The capability matrix currently allows it (intercepts are segments in the tree), but this inconsistency may warrant restricting it.

### `ctx.var` retention

Whether to keep `ctx.var` as a direct property alongside `get`/`set`, or remove it entirely in favour of function-only access.
