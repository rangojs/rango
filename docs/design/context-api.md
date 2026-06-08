# Context API Design

If you're adding a capability to a handler context — or just wondering why a
loader can `redirect()` but can't set a header — this is the model that decides
it. There's one rule underneath all of it, and once you have that rule the matrix
below mostly reads itself.

## The core principle

Every request-time handler shares a single base context, created once right after
route matching. Each handler type then gets a _view_ of it with capabilities
narrowed to match its execution semantics — and illegal operations are caught
twice: a TypeScript error at compile time, and a throw at runtime.

The rule that draws every line:

> **What is guaranteed to execute determines what you can mutate.**

If something always runs (middleware, or a route handler before its children), it
can safely own and write shared data. If something runs in parallel, is memoized,
or might not run at all, it stays read-only on anything shared. Hold that, and the
rest follows.

## Request lifecycle

```
Request -> Route matching -> Base context created -> Middleware -> Segment resolution -> Response
```

The base context is created once per request, right after route matching. It
holds the request properties, an empty variables map, and a response stub.
Middleware populates variables and may set headers/cookies. Segment resolution
(handlers, parallels, intercepts, loaders) reads from this context.

## Base context

### Request properties (read-only)

- `request` -- original HTTP request
- `url` -- parsed URL (handlers receive filtered version without `_rsc*` system params)
- `pathname` -- URL pathname
- `searchParams` -- always `URLSearchParams` (handlers receive filtered version)
- `search` -- typed search params from route schema, `{}` when no schema defined
- `params` -- route parameters from pattern matching
- `method` -- HTTP method
- `env` -- platform bindings (typed via `createRouter<TBindings>()`)

### Middleware variables

- `get(key)` -- read variables set by middleware (all handler types)
- `set(key, value)` -- write variables (middleware only)

### Response surface

- `res` -- stub response, headers merged into final response
- `headers` -- alias for `res.headers`
- `header(name, value)` -- shorthand for `res.headers.set()`
- `cookies()` -- standalone API: `cookies().get(name)`, `cookies().set(name, value, opts)`, `cookies().delete(name, opts)`
- `headers()` -- standalone API: read-only view of request headers

## Capability matrix

The whole surface in one grid — read each cell as "this handler type, can it do
this thing?"

| Capability              | Middleware    | Handler / Layout / Parallel / Intercept | Loader          | Action | Prerender |
| ----------------------- | ------------- | --------------------------------------- | --------------- | ------ | --------- |
| Request props           | all           | all                                     | all             | all    | synthetic |
| `get` (read vars)       | yes           | yes                                     | yes             | yes    | no        |
| `set` (write vars)      | yes           | yes (route handler only)                | no              | no     | no        |
| Response surface        | yes           | yes                                     | no              | yes    | no        |
| `use(loader)`           | no            | yes                                     | yes             | yes    | no        |
| `use(handle)`           | no            | yes                                     | no              | no     | yes       |
| `reverse`               | scoped+global | scoped+global                           | global          | global | no        |
| `redirect` / `notFound` | yes           | yes                                     | yes             | yes    | no        |
| `setLocationState`      | --            | yes                                     | no              | yes    | no        |
| `theme` / `setTheme`    | --            | yes                                     | no              | yes    | no        |
| `body` / `formData`     | --            | --                                      | yes (fetchable) | yes    | no        |

## Design rationale — why each line sits where it does

### `set` belongs to middleware and route handlers

Middleware runs on every request, so writing variables there is always safe.
Route handlers get `set` too, and the reason is worth spelling out: a handler runs
before its children (orphan layouts, parallels) during segment resolution, so it
can act as the data owner for its subtree.

There's no partial-execution loophole to worry about, either. Caching wraps all
segments for a route together (per-route, not per-segment). On a cache hit nothing
runs; on a cache miss everything runs, with the handler first. There is no
scenario where the handler is cached but its layout isn't.

So the division of labor is clean: middleware sets cross-cutting data (auth,
request ID); route handlers set subtree-scoped data (the fetched entities their
layout/parallel children need). Layouts, parallels, and intercepts cannot `set` —
they're children in the resolution order, and should only read.

### Loaders cannot touch the response

Loaders run in parallel and are memoized. Multiple loaders setting headers
concurrently is a race condition. So loaders stay pure data fetchers: read
context, return data.

### ...but loaders _can_ redirect and throw notFound

This looks like it contradicts the rule above, so it's worth the distinction.
Control flow (redirect, notFound, throw) aborts the request deterministically —
only one wins. That's different from response _decoration_ (headers, cookies,
handles), which is additive and races under parallel execution. A loader that
discovers moved or missing data needs to express that without duplicating the
logic up in middleware.

### Middleware has no `use`

Middleware is the setup layer. `use(loader)` would just duplicate the existing
pattern of fetching data in middleware and calling `ctx.set()`. `use(handle)` has
no meaning here — middleware has no segment identity to key handle data against.

### `reverse` scoping follows `include()` boundaries

Local dot-prefixed names (`.products`) resolve within the `include()` boundary
where the handler or middleware is defined. That's what makes includes composable:
middleware inside an `include()` can reference local routes without knowing their
global names, and the `include()` can be remounted without breaking references.
Loaders and actions resolve globally, since they are standalone definitions
outside route trees.

### Actions have no `use(handle)`

Handles are keyed by segment identity. Actions are standalone `"use server"`
functions — there's no segment in the rendering tree to key against.

### `set` is a function, not property assignment

It's `ctx.get(key)` / `ctx.set(key, value)`, not `ctx.var.key = value`, and the
reason is typing: a function can be typed as `never` per handler type to produce a
compile-time error. Property assignment cannot be restricted at the type level
per-context without complex wrappers.

## Open questions (and one settled decision)

Two items live here — one genuinely open, one a recorded decision kept for context.

### Intercepts and `use(handle)` — open

Intercepts only run on client-side navigation, not on SSR. If an intercept pushes
handle data, that data is present on client nav but absent on initial page load.
The capability matrix currently allows it (intercepts are segments in the tree),
but this inconsistency may warrant restricting it.

### `ctx.var` removal — decided

Decision: remove `ctx.var` from public contexts and keep variable access on
`ctx.get()` / `ctx.set()` only. The shared backing store remains internal.
