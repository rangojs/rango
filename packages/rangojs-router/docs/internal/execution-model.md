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
