# Execution Model

This is the canonical runtime contract for `@rangojs/router`.

Use this document as the source of truth for request flow, middleware scope,
segment recomputation, and context visibility.

## Terminology

- Full render pass: a complete render of the active tree (initial request,
  full HTML rerender, prerender build pass).
- Partial revalidation: action-driven recomputation of only selected segments.
- Global middleware: `router.use(...)` middleware.
- Route middleware: `middleware(...)` defined in `urls()` trees.
- Action execution phase: server action runs and may mutate cookies/headers/context.
- Revalidation phase: render step after action execution.
- Orphan layout: `layout(...)` nested under a `path(...)` use callback.
- Parallel slot: `parallel({ "@slot": ... })` segment rendered in a named outlet.

## Flow Overview

### 1) Normal request (no action)

```text
global middleware
  -> route middleware
    -> layout / handler / orphan / parallel / loaders
```

### 2) JS action request

```text
global middleware
  -> action executes
  -> route middleware wraps revalidation render
    -> revalidated layout / handler / orphan / parallel / loaders
```

### 3) PE form POST (no JS)

```text
global middleware
  -> action executes
  -> route middleware wraps full rerender
    -> HTML response
```

### 4) Intercept request

```text
global middleware
  -> route middleware
  -> intercept middleware
  -> intercept handler / intercept loaders
```

## Guarantees

- Global middleware wraps the entire request lifecycle.
- Route middleware wraps render passes, including:
  - normal renders
  - post-action revalidation renders
  - PE full rerenders
- Route middleware does not wrap action execution itself.
- Handler-first ordering is guaranteed within a full render pass:
  route handler runs before its child/orphan layouts and parallel children.
- `ctx.set()` values flow downward through structural scope boundaries only.
- Loaders are live by default unless explicitly cached via `cache()` in their
  use params: `loader(Fn, () => [cache({ ttl })])`.
- Route-level `cache()` does not cache loader segments; loaders remain live.
- Prerendered handlers can be frozen while loaders remain live.
- Parallel slots with `loading()` are independent streaming units. Their
  loaders run concurrently without blocking the parent layout or sibling
  routes — on SSR (skeleton renders immediately, data streams), on SPA
  navigation (existing slot UI stays visible, data refreshes in background),
  and on cache-hit paths (loaders are reconstructed fresh).
  Without `loading()`, parallel loaders block the parent.
- Slot override: when multiple `parallel()` calls define the same `@slot` name,
  the last definition wins. Earlier definitions of that slot are removed.

## Handler Loading Contract

Route handlers support two loading strategies: **sync** (default) and **lazy**
(deferred to first matching request).

### Supported handler shapes on `RouteEntry`

| Shape                            | When produced                  | Example                                 |
| -------------------------------- | ------------------------------ | --------------------------------------- |
| `() => Array`                    | `urls()` — sync DSL evaluation | `urls(({ path }) => [path("/", Page)])` |
| `() => Promise<{ default: fn }>` | Dynamic import wrapper         | `{ handler: () => import('./urls') }`   |
| `() => Promise<fn>`              | Lazy function wrapper          | `{ handler: () => loadUrls() }`         |

**Unsupported**: `() => Promise<Array>` (async route-tree construction).
Rejected at runtime with a diagnostic error. TypeScript structural compatibility
cannot catch this statically, so a runtime guard is essential.

### Lazy includes vs async handlers

These are two distinct code paths in `loadManifest()`:

1. **Lazy includes** (`entry.lazy && entry.lazyPatterns` branch): All `include()`
   calls are lazy by default — patterns are evaluated on first matching request
   via `evaluateLazyEntry()`. This is the primary user-facing lazy-loading
   mechanism, exercised by every included route in the e2e test suite.

2. **Async handler results** (the `result instanceof Promise` branch): Handles
   `Promise<{ default: fn }>` and `Promise<fn>` shapes on `RouteEntry.handler`.
   This is an **internal-only** mechanism — the public API (`urls()`, `include()`)
   always produces sync handlers. Coverage is at the unit/integration level
   (`router/__tests__/debug-manifest.test.ts`), not semantic e2e, because the
   async handler branch is not reachable through the public API surface.

### Policy: lazy loading yes, async construction no

Lazy **module loading** is supported — defer evaluation until first request.
Async **route-tree construction** is not — the DSL handler itself must be
synchronous once resolved. The handler receives route helpers and must call
them synchronously so that the ALS (AsyncLocalStorage) context captures all
side effects in the correct store.

### Contract change requirements

Any change to handler loading shapes must update:

1. Runtime enforcement in `manifest.ts` and `debug-manifest.ts`
2. Type definition in `types/route-entry.ts`
3. Type-level tests in `__tests__/route-entry-handler-types.check.ts`
4. Unit tests in `router/__tests__/debug-manifest.test.ts`

### Limitation: a Response from an async handler under `loading()` is not a redirect

On a route **without** `loading()`, a handler that returns or throws a `Response`
(e.g. `redirect()`) short-circuits to an HTTP redirect: the handler is awaited at
the resolution boundary, so the thrown `Response` propagates out to `match()`
and becomes a 302/308.

On a route that declares `loading()`, the handler result is **streamed** — it is
not awaited at the resolution boundary (`segment-resolution/fresh.ts`). So an
**async** handler that returns a `Response` has that `Response` surface only
during RSC serialization, where it is rendered into the stream via React's
error boundary instead of becoming an HTTP redirect. A **synchronous** `Response`
return on a `loading()` route still throws synchronously and redirects correctly;
only the async/Promise sub-branch is affected. Parallel slots with `loading()`
share this behavior.

To redirect from a `loading()` route, issue the redirect from middleware, a
loader, or a synchronous handler return. In development, `warnOnStreamedResponse`
(`segment-resolution/helpers.ts`) logs a warning when a streamed handler resolves
or rejects with a `Response`, so the swallowed-redirect failure mode is visible.

## Loader Context: params vs routeParams

Loaders receive two param fields:

- `ctx.params` — merged route params + explicit loader params. When a fetchable
  loader is called with `load(Loader, { params: { ... } })`, the explicit params
  override route-matched params.
- `ctx.routeParams` — server-trusted route params extracted from URL pattern
  matching. These cannot be overridden by client-provided loader params.

Use `ctx.routeParams` when the loader needs trusted route identity for
authorization or resource scoping (e.g., verifying the user owns the resource
at the matched URL). Use `ctx.params` for general data fetching where
client-provided params are acceptable.

### URL params: absent optionals are `undefined`

Absent optional segments (`:locale?`) are **omitted from the params record**
at runtime — `ctx.params.locale` reads as `undefined`, not `""`. This
matches the `RouteParams<"name">` type (`{ locale?: string }`) and the
public `useParams()` default (`Record<string, string | undefined>`).

| Pattern             | URL    | `ctx.params`         |
| ------------------- | ------ | -------------------- |
| `/:locale?`         | `/`    | `{}` (locale absent) |
| `/:locale?`         | `/en`  | `{ locale: "en" }`   |
| `/:locale?/c/:slug` | `/c/x` | `{ slug: "x" }`      |

Internal consumers tolerate both forms — `satisfiesConstraints` and
`reverse()` treat missing/undefined and `""` identically — so caller code
or `getParams()` shapes that pass `""` explicitly continue to work.

## Async Context Propagation

The router uses `AsyncLocalStorage` to maintain request context across all
execution phases. This context is established once per request and remains
readable through async/streaming boundaries.

### Request scope (`router.use(...)`)

Bindings set by global middleware are request-scoped. They are visible to:

- global middleware (subsequent `.use()` handlers)
- route middleware
- route handlers, layouts, orphan layouts, and parallel slots
- loaders (via `getRequestContext()`)
- server actions
- intercept handlers
- async server components, including after `await`
- streamed components behind `loading()` boundaries

### Render scope (`middleware(...)` in `urls()`)

Bindings set by route middleware are render-scoped. They are visible to:

- route handlers, layouts, orphan layouts, and parallel slots
- loaders (via `getRequestContext()`)
- async server components during the render pass
- post-action revalidation renders (route middleware wraps revalidation)
- PE full rerenders (route middleware wraps the rerender)

Route middleware does **not** wrap action execution. Actions see only
request-scoped bindings from `router.use(...)`. This is a hard contract
boundary, not an accident.

Route middleware has two placement modes:

- **Sibling mode** — `middleware(fn)` or `middleware([fn1, fn2])` attaches
  middleware to the parent entry (layout, path, etc.).
- **Wrapping mode** — `middleware(fn, () => [...])` or
  `middleware([fn1, fn2], () => [...])` creates a transparent layout that
  scopes the middleware to its children only.

The variadic form `middleware(fn1, fn2, fn3)` is not supported. Use
`middleware([fn1, fn2, fn3])` to pass multiple middleware.

### Intercept scope

Bindings set by intercept middleware are visible only to the intercept
render path. Direct navigation to the same target route does not execute
intercept middleware.

### Async and streaming limits

Async server components inherit the request ALS through render and streaming.
`getRequestContext()` remains readable after `await` and inside streamed
children behind `loading()` boundaries.

However, late streaming may hit separate feature-specific mutation limits.
Handle data (`ctx.use(handle)`) is accumulated into a `HandleStore` that
settles independently. Read probes (reading context variables) are safe
throughout streaming; mutation APIs (like handle pushes) have their own
deadlines documented in `handle-store.ts`.

## Fetchable Loader Middleware

Fetchable loaders accept per-loader middleware via the object form:

```ts
createLoader(fn, { middleware: [authMw, rateLimitMw] });
```

This middleware runs **only** on `_rsc_loader` fetch requests (client-initiated
`load()` / `useFetchLoader()` calls). It does **not** run during:

- SSR render-time `ctx.use(loader)` execution
- Navigation-triggered loader resolution
- Build-time pre-rendering

The execution path is:

```text
_rsc_loader request
  -> global middleware (router.use)
  -> fetchable loader middleware (per-loader)
    -> loader function
```

This is intentional: during SSR, the loader runs inside the route middleware
scope and inherits its protections. The per-loader middleware exists to guard
the standalone fetch endpoint, which bypasses route middleware entirely.

## Client Refresh Fan-out

This is a **client-only** contract: which mounted `useLoader` / `useFetchLoader`
reads observe the result of a `load()`. It is independent of the server
execution model above and of `cache()` / `revalidate()`; it never changes the
request sent to the server. Owned by `src/use-loader.tsx` + `src/loader-store.ts`
(the per-tab module-level `loaderStore`). The store is partitioned into buckets;
each bucket key is `loader.$$id`, or `loader.$$id + key` when the hook is given
an explicit client refresh `key`. Buckets of one loader form a family (indexed
by `$$id`) so a route-context reset can clear them together.

| `load(...)` call                     | No `key`                                        | With `key`                         |
| ------------------------------------ | ----------------------------------------------- | ---------------------------------- |
| `load()` (or GET, no params/body)    | shared by `$$id` iff loader is in route context | shared by `$$id + key`             |
| `load({ params })`                   | local to the calling hook                       | shared by `$$id + key`             |
| `load({ method: non-GET })` / `body` | local to the calling hook                       | local to the calling hook          |
| loader not in route context          | local to the calling hook                       | shared by `$$id + key` (ephemeral) |

`isLoading` and `error` follow the bucket. `throwOnError: true` render-throws are
scoped to the **originating** hook: a shared error is thrown only by the hook
whose `load()` produced it (matched on the bucket's `requestId`); co-bucket
siblings expose it via `error` without throwing. A successful follow-up `load()`
clears the shared error.

Bucket reset has two boundaries:

- **Sticky buckets** (any route-registered reader subscribed) reset on
  route-context change via `clearFamily(loaderId)` — navigation / action
  revalidation re-seeds them from fresh `loaderData`.
- **Ephemeral buckets** (only ever read by hooks with no route context — keyed
  `useFetchLoader` of an unregistered loader) have no route-context trigger, so
  they are reference-counted: dropped once the last subscriber unsubscribes
  (deferred a microtask, cancelled on resubscribe, held until any in-flight load
  settles). A persistent reader outside the outlet keeps its value across a
  navigation; a route-scoped reader's value is reclaimed on unmount.

**Cross-loader refresh groups.** `key` partitions readers of one loader; the
`refreshGroup` option + `useRefreshLoaders()` refresh **different** loaders
together. A read may be tagged with one group name or several (`refreshGroup` is
`string | string[]`), and the inverted hook takes the group(s) at call time:
`useRefreshLoaders()` returns `refresh(groups: string | string[])`. The store
keeps a `groups: Map<name, Set<bucketKey>>` index, with membership refcounted per
subscriber on each entry (`entry.groups: Map<name, count>`) so a bucket can belong
to several groups at once — whether from one read carrying multiple tags or
different reads tagging the same keyed bucket — and leaves a group only when that
group's last subscriber unmounts, independent of subscribe/unsubscribe order.
`refreshGroups(names)` unions the member buckets across every named group (deduped
by bucket key, so a bucket in two of the named groups fetches once), runs each
member's registered plain-GET thunk (current route URL, no params/body),
`Promise.allSettled`s them, and rejects with an `AggregateError` on any failure.
Group refresh never render-throws — failures surface via each member's `error` and
the returned promise; handle them at the await site. It is GET-only by design: a
group spans heterogeneous loaders, so there is no coherent params or aggregate
return type.

A grouped reader with **no explicit `key`** is given a private per-hook bucket
(`loader.$$id::<private>`) rather than the bare `loader.$$id` bucket. Otherwise a
group refresh would write the shared loader-id bucket and leak into unrelated
unkeyed reads of the same loader, which the fan-out table keeps local. Sharing a
value within a group is therefore opt-in via a common `key`.

## Non-Guarantees

- Route middleware is not an action guard.
- Partial revalidation does not implicitly recompute non-revalidated ancestors.
- `ctx.set()` values do not cross arbitrary sibling boundaries.
- Parallel slots do not share a single global context; visibility is structural.

## Context Scope Rules

Context visibility follows tree location, not component appearance.

Example shape:

```text
layout
  |- path("/")
  |    |- orphan layout
  |         |- parallel("@sub-panel")
  |- orphan layout (sibling of path)
  |    |- parallel("@orphan-panel")
  |- parallel("@panel")
```

Expected visibility pattern:

- `@sub-panel` can see path-local handler data and outer layout data.
- `@orphan-panel` can see outer layout data, not path-local handler data.
- layout-level `@panel` can see layout data (handler-first), not path-local handler data.

### Cache-safety contract for context variables

Context variables have a cache-safety flag controlled at two levels:

- **Var-level**: `createVar<T>({ cache: false })` — all values are non-cacheable.
- **Write-level**: `ctx.set(var, value, { cache: false })` — this specific value
  is non-cacheable, even if the var itself is cacheable.

"Least cacheable wins": if either the var or the write says `cache: false`, the
stored value is non-cacheable.

**Enforcement is at read time, not write time.** `ctx.set()` stores the
cache-safety metadata alongside the value but does not throw. When `ctx.get()`
is called inside a cache scope (detected via ALS — same mechanism as the
existing `"use cache"` guards), it checks the stored metadata and throws if
the value is non-cacheable.

- `ctx.get(cacheableVar)` inside cache scope: allowed.
- `ctx.get(nonCacheableVar)` inside cache scope: throws.
- `ctx.set(var, value)` inside cache scope: allowed for cacheable vars (children
  are also inside the cache boundary).
- Response-level side effects throw inside cache scope regardless of cache-safety
  flag: from a handler, `ctx.headers.set/append/delete()` (the guarded Headers
  proxy) and `cookies().set/delete()` (the cookie-store guard); from middleware
  wrapping the cached render, `ctx.header()` / `ctx.headers.*`. (`setStatus()` /
  `setCookie()` / `onResponse()` live on the full request context, not the handler
  or middleware `ctx`.) DSL loaders are exempt — see below.

### Loader access paths and cache safety

DSL loaders (registered with `loader()`) and handler-called loaders
(`ctx.use(Loader)`) have different cache-safety guarantees:

- **DSL `loader()` + client `useLoader()`** — the recommended path. DSL
  loaders are always resolved fresh (never cached), even inside `cache()`
  boundaries. Because they always re-execute:
  - `ctx.get()` bypasses non-cacheable read guards (unguarded context).
  - Global helpers that touch the response (`cookies().set()`,
    `cookies().delete()`, `headers()`) are allowed inside loader
    functions. `LoaderContext` itself does not expose `setCookie` or
    `header` — loaders access these through the module-level helpers
    imported from `@rangojs/router`, which delegate to the request
    context. The cache-scope guard is bypassed via a dedicated
    `loaderScopeALS` that tracks loader execution separately from the
    `insideCacheScope` flag on `RangoContext`.
  - This applies to all DSL loader resolution paths: fresh, revalidation,
    and intercept.

- **`ctx.use(Loader)` in handlers** — escape hatch for reading loader
  data in handlers. The loader function itself runs fresh, but the
  handler embeds the result in JSX that is cached with the segment. On
  cache hit the handler does not re-execute, so the embedded value is
  served from the stored shell. For request-scoped data (a loader that
  reads `cookies()`/`headers()`) this is not merely stale — it is a
  **cross-user leak**: one visitor's value, baked into the shared shell,
  is served to later visitors until the entry expires. The cache-purity
  guard does **not** catch this, because the request-scoped read happens
  inside the (exempt) loader body, not in the handler. **Do not embed a
  request-reading loader's result via `ctx.use()` in a cached handler —
  consume it with `useLoader()` in a client component instead** (a fresh,
  never-cached segment). Non-cacheable variable reads in the handler
  itself still throw via the normal read guard. Response-level side
  effects in handler code throw normally.
  Note: when a loader is registered via both DSL `loader()` and called
  via `ctx.use()` in the same route, the DSL registration starts the
  loader in loader scope before the handler runs. The handler's
  `ctx.use()` call returns the memoized promise — it does not re-execute
  the loader function. The loader scope bypass applies because the
  function originally started under `runInsideLoaderScope`.

This is a deliberate design decision: DSL loaders are the semantically
strong path for request-specific data. `ctx.use(Loader)` is supported
for convenience (e.g., setting context variables from loader data) but
should not be treated as equivalent.

## Revalidation Contract

- Revalidation is segment-scoped and opt-in by rules (`revalidate(...)`).
- During partial action revalidation:
  - only revalidated segments recompute
  - non-revalidated ancestors do not rerun just to rebuild `ctx.set()` state
  - downstream `ctx.get()` calls therefore see missing/`undefined` upstream
    values unless the producer reruns; the router does not preserve a prior-pass
    ancestor snapshot for you
- If a child depends on data set by an outer segment:
  - revalidate that outer segment too, or
  - load/guard the data in the child independently.

### Revalidation Contracts Pattern

For shared `ctx.set()` data, prefer named revalidation contracts and reuse
them on both producer and consumer segments.

```ts
// revalidation-contracts.ts
export const revalidateCartData = ({ actionId }: { actionId?: string }) =>
  actionId?.includes("src/actions/cart.ts#addToCart") ?? false;
```

```ts
layout(CartLayout, () => [
  revalidate(revalidateCartData), // producer reruns
  path("/cart", CartPage, { name: "cart" }, () => [
    revalidate(revalidateCartData), // consumer reruns
  ]),
]);
```

Multiple dependency domains can coexist. Compose multiple contracts in the same
segment when it depends on multiple upstream data sources.

```ts
layout(ShellLayout, () => [
  revalidate(revalidateAuthData),
  revalidate(revalidateCartData),
  path("/checkout", CheckoutPage, { name: "checkout" }, () => [
    revalidate(revalidateAuthData),
    revalidate(revalidateCartData),
  ]),
]);
```

### Contract Handoff Helpers

To avoid repeating `revalidate(contract)` at each callsite, package contracts
as reusable DSL helpers that can be imported and spread into any segment.

```ts
// revalidation-contracts.ts
import { revalidate } from "@rangojs/router";

export const revalidateAuthData = ({ actionId }) =>
  actionId?.includes("src/actions/auth.ts#") ?? false;

export const revalidateCartData = ({ actionId }) =>
  actionId?.includes("src/actions/cart.ts#") ?? false;

export const revalidateAuth = () => [revalidate(revalidateAuthData)];

export const revalidateCart = () => [revalidate(revalidateCartData)];
```

```ts
import { revalidateAuth, revalidateCart } from "./revalidation-contracts";

urls(({ path, layout }) => [
  layout(ShellLayout, () => [
    revalidateAuth(),
    revalidateCart(),
    path("/checkout", CheckoutPage, { name: "checkout" }, () => [
      revalidateAuth(),
      revalidateCart(),
    ]),
  ]),
]);
```

## Prerender Contract

- Prerender build passes are full render passes.
- Child layouts/parallels inside the prerendered path can read handler-set data
  in that same build render pass.
- Runtime passthrough and action revalidation still follow partial revalidation
  rules.

## Middleware Placement Guidance

- Use global middleware for request-level concerns:
  auth guards, request ownership, coarse policy checks.
- Use route middleware for render-level concerns:
  context shaping for handlers/layouts, render headers, route-scoped cookies.
- Use wrapping middleware to scope middleware to a subset of routes
  without introducing a visible layout:
  `middleware(authMw, () => [path("/admin", AdminPage)])`.
  This creates a transparent layout (renders `<Outlet />`) that carries
  the middleware only for its children.

## PE vs JS Parity Expectations

For equivalent action intents, JS and PE paths should match on:

- render visibility of route middleware effects
- cookie/header propagation in responses
- segment data expectations for revalidated/rerendered scopes

When behavior diverges, treat it as a contract bug unless explicitly documented.

## Contract Change Process

Any semantic change to this model must include:

1. updates to this document
2. updates to affected skill docs
3. semantic e2e coverage for dev + production
4. review against the semantic checklist:
   [semantic-change-checklist.md](./semantic-change-checklist.md)
