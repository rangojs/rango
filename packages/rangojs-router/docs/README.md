# Rango Router Docs

This package has a small core and a larger advanced model.

If you are new to Rango, start with named routes, `urls()`, `path()`,
`layout()`, `include()`, and `reverse()`. Everything else builds on top of
that route tree.

## Core Topics

- [`README.md`](../README.md) - package overview and quick start
- [Route definition rules](./route-definition-rules.md) - what the route DSL
  allows and rejects
- [Manifests](./manifests.md) - generated route maps and runtime manifest data

## Rendering And Semantics

- [Execution model](./internal/execution-model.md) - request flow, middleware
  scope, propagation rules, and revalidation semantics
- [Tree structure](./tree-structure.md) - React tree invariants that must stay
  stable across SSR, navigation, and action renders
- [Stability roadmap](./internal/stability-roadmap.md) - where the router is
  trying to get stricter and easier to reason about

## Caching And Prerender

- [Prerender design](./prerender-api-design.md) - build-time rendering and
  runtime cache lookup model
- [`"use cache"` API design](./use-cache-api-design.md) - function/component
  caching and cache profiles

## Observability

- [Telemetry & Performance Timeline](./telemetry.md) - `debugPerformance`
  waterfall, `Server-Timing` headers, middleware pre/post timeline,
  structured lifecycle events, console sink, OpenTelemetry adapter, custom
  sinks

## Design Notes

- [SSR streaming policy](./design/ssr-streaming-policy.md) - controlling
  stream vs allReady mode per request
- [Consolidate generated route type files](./design/consolidate-gen-files.md)

## Internal Reference

These are internal implementation maps for contributors, not consumer-facing
API docs. They cover both public and internal surfaces.

- [API boundary policy](./internal/api-boundary-policy.md) - where public
  exports belong vs `./server` and `./__internal`
- [Feature map](./internal/feature-map.md) - implementation inventory by
  export path and capability (includes internal-only APIs)
- [Feature-to-file map](./internal/feature-file-map.md) - which source
  files own each feature

## Internal Review Docs

Internal notes and review plans live under [`docs/internal`](./internal).
They are useful when changing router semantics, tests, or implementation
details, but they are not the first stop for learning the public API.

- [Prerender passthrough action plan](./internal/prerender-passthrough-action-plan.md)
  - implementation plan for explicit `ctx.passthrough()` prerender behavior
