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
- If a child depends on data set by an outer segment:
  - revalidate that outer segment too, or
  - load/guard the data in the child independently.

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
