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
- [Matching & lazy-discovery](./internal/matching-and-lazy-discovery.md) -
  architecture & accepted tradeoffs: dev/prod matching parity, the trie-vs-regex
  contract, the matching invariants, and the measured lazy include() cost tradeoffs

## Caching And Prerender

- [Prerender design](./prerender-api-design.md) - build-time rendering and
  runtime cache lookup model
- [`"use cache"` API design](./use-cache-api-design.md) - function/component
  caching and cache profiles

## Build Integrations

- [React Compiler](./react-compiler.md) - opt-in wiring via `@rolldown/plugin-babel`
  - `reactCompilerPreset()` for both the default and `cloudflare` presets, plus how
    it interacts with build-time prerender
- [Client chunking](./client-chunking.md) - how the browser bundle splits across
  routes / `include()` / host apps, and the `clientChunks` option for per-route
  splitting to shrink a route's client bundle

## Observability

- [Telemetry & Performance Timeline](./telemetry.md) - `debugPerformance`
  waterfall, `Server-Timing` headers, middleware pre/post timeline,
  structured lifecycle events, console sink, OpenTelemetry adapter, custom
  sinks

## Design Notes

- [SSR streaming policy](./design/ssr-streaming-policy.md) - controlling
  stream vs allReady mode per request
- [Consolidate generated route type files](./design/consolidate-gen-files.md)
- [`ctx.isAction()` API design](./design/is-action-api-design.md) - typed,
  rename-safe action matching for `revalidate()` (implemented)
- [Handles completion detection](./design/handles-completion.md) - research &
  options for detecting RSC render completion to finalize handle collection; why
  every in-band completion signal is circular, and the cache bugs the audit found

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
Completed, superseded, and point-in-time plan/handoff docs are moved to
[`internal/archive`](./internal/archive) — kept for history, not maintained.

- [Prerender passthrough action plan](./internal/archive/prerender-passthrough-action-plan.md) (archived)
  - superseded — documents the migration from `{ passthrough: true }` to `Passthrough()` wrapper
- [Why include() is synchronous](./internal/why-includes-is-sync.md) -
  design rationale for the `UrlPatterns`-only `include()` signature and
  the trie/reverse-map/type-gen/prerender invariants it protects
- [Why SSR/RSC streaming uses Web Streams everywhere](./internal/why-web-streams-everywhere.md) -
  why both render layers use `renderToReadableStream` on Node (not
  `renderToPipeableStream`), the conversion-tax and plugin-locked-Flight
  constraints, and that edge/node conditions resolve correctly
- [FILE_NAME_CONFLICT build warnings](./internal/file-name-conflict-warnings.md) -
  why the shared `onwarn` suppresses content-hashed asset re-emit collisions
  from `@vitejs/plugin-rsc`'s cross-environment copy, the sourcemap-safety
  argument, and why the warning is only reproducible in a host-router multi-app
- [Generated route type surfaces handoff](./internal/archive/generated-route-type-surfaces-handoff.md) (archived) -
  **completed audit** (findings applied to the skills/docs); retained as the
  record of the three generated type surfaces — `GeneratedRouteMap`, per-module
  `.gen.ts`, and `RegisteredRoutes` — and response/MIME payload inference
- [Loader client refresh key handoff](./internal/archive/loader-client-refresh-key-handoff.md) (archived) -
  proposal handoff for adding a hook-level client refresh key to partition
  `useLoader()` / `useFetchLoader()` `load()` fan-out
