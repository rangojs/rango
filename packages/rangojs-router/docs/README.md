# Rango Router Docs

This package has a small core and a larger advanced model.

If you are new to Rango, start with
[named routes](../../../docs/named-routes.md), `urls()`, `path()`,
`layout()`, `include()`, and `reverse()`. Everything else builds on top of
that route tree.

If you are evaluating Rango against other frameworks, start with the comparison.

## Positioning

- [Comparison](./comparison.md) - Rango versus Next.js, TanStack Start, and Waku:
  the unified caching/prerender model, progressive-enhancement parity, the runtime
  mechanics (partial rendering, named slots/intercepts, `revalidate()`, prefetch
  gating, Rango State and userland invalidation, loaders and tagged loading),
  deployment-skew recovery, CSP nonce propagation, default CSRF origin checks,
  tainted request-context cache safety, why the loader is a genuinely new primitive,
  and an account of where the established frameworks still lead

## Core Topics

- [Why Rango](./why-rango.md) - the load-bearing ideas, each shown in code:
  the explicit route tree, named routes, content-negotiated and type-inferred
  response routes, the two freshness axes, live-by-default loaders, metadata
  through handles, the shell manifest pattern, instant navigation with safe
  invalidation, and semantics as a tested contract
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
- [Semantic change checklist](./internal/semantic-change-checklist.md) - the
  pre-merge checklist for PRs that touch routing, rendering, middleware,
  actions, revalidation, intercepts, prerender, or request-context propagation
- [Security checklist](./internal/security-checklist.md) - the checklist for
  changes that add or alter execution paths, transport behavior, or
  request/response ownership
- [Rendered barrier](./internal/rendered-barrier.md) - the experimental
  `await ctx.rendered()` loader barrier: lets a loader wait for the handler
  tree to settle so it can read accumulated handle data
- [Runtime guardrails design](./internal/runtime-guardrails-design.md) -
  dev-mode misuse warnings (warn, never silently fix): which guardrails
  shipped, which were removed, and why

## Caching And Prerender

- [Prerender design](./prerender-api-design.md) - build-time rendering and
  runtime cache lookup model
- [On-demand prerender design](./design/ondemand-prerender.md) - implemented
  ISR-style durable prerender refresh from fetch, cron, queues, workflows, and
  webhooks
- [`"use cache"` API design](./use-cache-api-design.md) - function/component
  caching and cache profiles
- [Segment caching design](../../../docs/design/caching.md) - the canonical
  runtime segment-cache design; read before changing caching
- [Cache tags flow](../../../docs/design/cache-tags-flow.md) - tag
  invalidation end to end: `updateTag()`/`revalidateTag()`, tag markers, and
  the read-latency budgets
- [Vercel cache store](../../../docs/design/vercel-cache-store.md) -
  `VercelCacheStore` and the `vercel` preset design

## Build Integrations

- [React Compiler](./react-compiler.md) - opt-in wiring via `@rolldown/plugin-babel`
  - `reactCompilerPreset()` for both the default and `cloudflare` presets, plus how
    it interacts with build-time prerender
- [Client chunking](./client-chunking.md) - how the browser bundle splits across
  routes / `include()` / host apps, and the `clientChunks` option for per-route
  splitting to shrink a route's client bundle

## Testing

- [Testing guide](./testing.md) - the RSC-first testing pyramid and the
  consumer testing surface, split into six entries by test runtime:
  `@rangojs/router/testing` (unit: `runLoader`, `runMiddleware`; integration:
  `dispatch`; cache/prerender signals; generated-route drift),
  `@rangojs/router/testing/vitest` (the `rangoTestConfig` setup preset),
  `@rangojs/router/testing/dom` (`renderRoute`),
  `@rangojs/router/testing/e2e` (`createRangoE2E` -> `parityDescribe`,
  `expectParity`), `@rangojs/router/testing/flight`
  (`renderServerTree` — the default for asserting a Flight render, typed boundary
  props — and `renderToFlightString`, the escape hatch for pinning the raw wire
  payload; real Flight under the react-server condition), and
  `@rangojs/router/testing/flight-matchers` (`flightMatchers`). See also the
  [`/testing` skill](../skills/testing/SKILL.md).

## Observability

- [Telemetry & Performance Timeline](./telemetry.md) - `debugPerformance`
  waterfall, `Server-Timing` headers, middleware pre/post timeline,
  structured lifecycle events, console sink, OpenTelemetry adapter, custom
  sinks

## Design Notes

- [Render stage driver](./design/render-stage-driver.md) - the migration from
  post-work async-generator checkpoints to a synchronous typed effect plan and
  one async foreground driver, including streaming, diagnostics, observability,
  performance gates, and the boundaries that remain concurrent
- [SSR streaming policy](./design/ssr-streaming-policy.md) - controlling
  stream vs allReady mode per request
- [PPR shell caching and resume](./design/ppr-shell-resume.md) - the opt-in
  second render axis: caches the rendered HTML shell (React `prerender` prelude
  bytes + `postponed` state) and, on a hit, serves the shell bytes immediately
  and resumes fizz for just the live holes. Covers the `ppr` path option
  (`PartialPrerenderProps`), the integrated serve path (commit after all
  middleware), the hole doctrine (structural/physics/shell + the handles
  contract), the `createShellCaptureHandler`/`createShellResumeHandler` SSR
  factories, the `getShell`/`putShell` store family, and the loader-masking /
  capture / resume contracts
- [Vercel chain PPR adapter spec](./design/vercel-chain-ppr.md) - serving
  build-time PPR shells via Vercel's CDN-stitched `chain` protocol (shell from
  the PoP cache + `next-resume: 1` POST to the resume function). Source-derived
  from the Vercel/Next builder internals: the `.prerender-config.json` `chain`
  shape, the `application/x-nextjs-pre-render; state-length=N` fallback split,
  the resume request contract, what is public vs undocumented vs Next-only, and
  the Rango adapter spec (build-time capture prerequisite, the signed-blob resume
  endpoint, and in-function fallback as the universal path)
- [Consolidate generated route type files](./design/consolidate-gen-files.md)
- [`ctx.isAction()` API design](./design/is-action-api-design.md) - typed,
  rename-safe action matching for `revalidate()` (implemented)
- [Handles completion detection](./design/handles-completion.md) - research &
  options for detecting RSC render completion to finalize handle collection; why
  every in-band completion signal is circular, and the cache bugs the audit found
- [Resolved-by-default handles](./design/handles-resolved-by-default.md) - a
  deferred (Promise) handle value is resolved before any consumer sees it
  (server-side on full render, client-side await-then-apply on navigation), so
  `collect`/`useHandle` only ever see resolved values
- [Rango state cookie storage & single invalidation API](../../../docs/design/rango-state-cookie.md) -
  moving the rango state from localStorage to a session cookie and collapsing
  cache invalidation to `invalidateClientCache()` / `keepClientCache()`
- [Shallow navigation](./design/shallow-navigation.md) - client-only URL
  updates that skip server RSC revalidation, via `revalidate: false` on
  `<Link>` / `navigate()` (implemented)

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
[`internal/reviews`](./internal/reviews) holds point-in-time review
snapshots — also kept for history, not maintained.

- [Prerender passthrough action plan](./internal/archive/prerender-passthrough-action-plan.md) (archived)
  - superseded — documents the migration from `{ passthrough: true }` to `Passthrough()` wrapper
- [include() and async route loading](./internal/async-includes.md) -
  the eager vs. async `() => import()` include forms, how discovery awaits
  providers to keep the trie/reverse-map/type-gen/prerender invariants complete
  while the module import defers, and the runtime contract (sometimes-async
  `evaluateLazyEntry`, the three handler-run sites, concurrent dedupe)
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
