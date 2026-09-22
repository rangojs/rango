# Rango Router Docs

This folder holds the prose documentation for `@rangojs/router`: the design
rationale, a few user-facing guides, the canonical architecture designs, and
contributor-facing design and internal notes.

**For task-oriented guidance** ("add a route", "attach a loader", "cache this
segment", "test this middleware"), use the skills that ship with the package.
Start with [`/rango`](../skills/rango/SKILL.md), which maps every topic to its
skill (`/route`, `/loader`, `/caching`, `/testing`, ...). The package
[`README.md`](../README.md) has the overview and quick start.

If you are new to Rango, start with
[named routes](../../../docs/named-routes.md), `urls()`, `path()`,
`layout()`, `include()`, and reverse routing (`ctx.reverse()` on the server,
`href()` / `useReverse()` on the client). Everything else builds on top of
that route tree.

If you are evaluating Rango against other frameworks, start with
[Why Rango](./why-rango.md) and the comparison.

## User-facing guides

- [Why Rango](./why-rango.md) - the load-bearing ideas, each shown in code:
  the explicit route tree, named routes, content-negotiated and type-inferred
  response routes, the two freshness axes, live-by-default loaders, metadata
  through handles, the shell manifest pattern, instant navigation with safe
  invalidation, and semantics as a tested contract
- [Comparison](./comparison.md) - stub that points to the canonical
  [`/comparison` skill reference](../skills/comparison/references/framework-comparison.md):
  Rango versus Next.js, TanStack Start, and Waku (caching/prerender model,
  progressive-enhancement parity, partial rendering, loaders, deployment-skew
  recovery, CSP nonces, CSRF origin checks, and where the established
  frameworks still lead)
- [Route definition rules](./route-definition-rules.md) - what the route DSL
  allows and rejects, orphan layouts and caches, include name scoping, and
  which rules TypeScript catches versus runtime guards
- [Client URL routes](./client-urls.md) - opt-in `clientUrls()` route groups:
  optimistic destination rendering while canonical server Flight remains
  authoritative, the supported DSL surface, hook semantics inside a group, and
  the security boundary
- [Client chunking](./client-chunking.md) - how the browser bundle splits across
  routes / `include()` / host apps, and the `clientChunks` option for per-route
  splitting to shrink a route's client bundle
- [React Compiler](./react-compiler.md) - opt-in via plugin-react 6.1's native
  `compiler` option (oxc-transform-react): client-only contract, options, the
  prerender interaction, and the Babel fallback wiring
- [Testing guide](./testing.md) - the RSC-first testing pyramid and the
  consumer testing surface, split into six entries by test runtime:
  `@rangojs/router/testing` (unit: `runLoader`, `runMiddleware`; integration:
  `dispatch`; cache/prerender signals; generated-route drift),
  `@rangojs/router/testing/vitest` (the `rangoTestConfig` setup preset),
  `@rangojs/router/testing/dom` (`renderRoute`),
  `@rangojs/router/testing/e2e` (`createRangoE2E` -> `parityDescribe`,
  `expectParity`), `@rangojs/router/testing/flight`
  (`renderServerTree`, the default for asserting a Flight render with typed
  boundary props; `renderHandler` for a real route handler; and
  `renderToFlightString`, the escape hatch for pinning the raw wire payload),
  and `@rangojs/router/testing/flight-matchers` (`flightMatchers`). See also
  the [`/testing` skill](../skills/testing/SKILL.md).
- [Telemetry & Performance Timeline](./telemetry.md) - `debugPerformance`
  waterfall, `Server-Timing` headers, middleware pre/post timeline,
  structured lifecycle events, console sink, OpenTelemetry, Cloudflare and
  Vercel tracing adapters, custom sinks. See also the
  [`/observability` skill](../skills/observability/SKILL.md).

## Architecture and canonical designs

Read these before changing the corresponding subsystem.

- [Prerender design](./prerender-api-design.md) - canonical. Prerender is a
  build-time cache: build flow, prerender store, `BuildContext`, handler
  eviction, `Passthrough()`, intercept prerendering, build-time PPR shells, and
  the runtime cache-lookup model
- [`"use cache"` API design](./use-cache-api-design.md) - function/component
  caching: directive forms, cache profiles, keys and tainted arguments, the
  Vite transform, the runtime, and embedded server actions
- [Segment caching design](../../../docs/design/caching.md) - the canonical
  runtime segment-cache design; read before changing caching
- [Cache tags flow](../../../docs/design/cache-tags-flow.md) - tag
  invalidation end to end: `updateTag()`/`revalidateTag()`, tag markers, and
  the read-latency budgets
- [Shell fast path](../../../docs/design/shell-fast-path.md) - the PPR shell
  entry as a `cache()` of the handler layer, and the fragment splice
- [Vercel cache store](../../../docs/design/vercel-cache-store.md) -
  `VercelCacheStore` and the `vercel` preset design
- [Rango state cookie storage & single invalidation API](../../../docs/design/rango-state-cookie.md) -
  the session-cookie rango state and cache invalidation through
  `invalidateClientCache()` / `keepClientCache()`
- [Response routes design](../../../docs/design/mime-routes.md) - how
  `path.json()` and the other response routes are matched and served outside
  the RSC pipeline
- [Context API design](../../../docs/design/context-api.md) - the shared base
  request context and what each handler type may mutate
- [Manifests](./manifests.md) - generated route maps (`*.named-routes.gen.ts`,
  per-module `.gen.ts`), the route-manifest virtual modules, and dev/build
  generation
- [Tree structure](./tree-structure.md) - React tree invariants that must stay
  stable across SSR, navigation, and action renders
- [Deployment caching skill](../skills/deployment-caching/SKILL.md) - choose
  between in-function segment/prerender/PPR caches, Rango's store-backed
  response middleware, and an external HTTP CDN cache

## Design notes (`design/`)

Design records for shipped features and open investigations. The status line
at the top of each note says whether it is implemented, deferred, or
historical.

- [clientUrls × client hooks — settlement review](./design/client-urls-hooks-review.md) -
  tracking document for the full `@rangojs/router/client` hook surface
  against the group model: settled/pinned rows, structural non-fits, and
  the open decisions with candidate designs
- [Client URL implementation plan](./design/client-urls-implementation-plan.md) -
  implementation record for the shipped `clientUrls()` slice, plus deferred
  designs for route-local middleware and route-data optimization
- [Client URL groups and instant navigation](./design/client-urls-instant-navigation.md) -
  design background for `"use client"` + `clientUrls()` route groups
- [Client URL groups: optimistic destination](./design/client-urls-optimistic-destination.md) -
  the shipped default where an in-group navigation renders the destination
  component immediately and its loader reads suspend until the canonical commit
- [Render stage driver](./design/render-stage-driver.md) - the migration from
  post-work async-generator checkpoints to a synchronous typed effect plan and
  one async foreground driver
- [Routine plans](./design/routine-plans.md) - the request-level render
  orchestration expressed as synchronous plans run by one runner, one level
  above the render stage driver
- [SSR streaming policy](./design/ssr-streaming-policy.md) - controlling
  stream vs allReady mode per request
- [Late-span retention on Cloudflare](./design/late-span-retention.md) - open
  investigation: whether phase spans that settle after `router.fetch()` returns
  survive in the exported Cloudflare trace
- [PPR shell caching and resume](./design/ppr-shell-resume.md) - the opt-in
  second render axis: the `ppr` path option, the integrated serve path, the
  hole doctrine, the shell capture/resume SSR factories, the `getShell` /
  `putShell` store family, and wedge containment
- [Loader container bake](./design/loader-container-bake.md) - one promise
  doctrine for handlers, handles, and loaders under PPR; the
  `loader(Def, { ssr: false })` bake lane
- [Vercel CDN-stitched PPR research](./design/vercel-chain-ppr.md) - rejected
  adapter direction and why the shipped Vercel preset keeps PPR shells inside
  its streaming Node Function
- [Consolidate generated route type files](./design/consolidate-gen-files.md)
- [`ctx.isAction()` API design](./design/is-action-api-design.md) - typed,
  rename-safe action matching for `revalidate()` (implemented)
- [Handles completion detection](./design/handles-completion.md) - research &
  options for detecting RSC render completion to finalize handle collection
- [Resolved-by-default handles](./design/handles-resolved-by-default.md) - a
  deferred (Promise) handle value is resolved before any consumer sees it, so
  `collect`/`useHandle` only ever see resolved values
- [Shallow navigation](./design/shallow-navigation.md) - client-only URL
  updates that skip server RSC revalidation, via `revalidate: false` on
  `<Link>` / `navigate()` (implemented)

## Internal reference (`internal/`)

Implementation maps and review checklists for contributors, not consumer-facing
API docs. They cover both public and internal surfaces.

- [Execution model](./internal/execution-model.md) - request flow, middleware
  scope, propagation rules, and revalidation semantics
- [API boundary policy](./internal/api-boundary-policy.md) - where public
  exports belong vs `./server` and `./__internal`
- [Feature map](./internal/feature-map.md) - implementation inventory by
  export path and capability (includes internal-only APIs)
- [Feature-to-file map](./internal/feature-file-map.md) - which source
  files own each feature
- [Stability roadmap](./internal/stability-roadmap.md) - where the router is
  trying to get stricter and easier to reason about
- [Matching & lazy-discovery](./internal/matching-and-lazy-discovery.md) -
  dev/prod matching parity, the trie-vs-regex contract, the matching
  invariants, and the measured lazy include() cost tradeoffs
- [Semantic change checklist](./internal/semantic-change-checklist.md) - the
  pre-merge checklist for PRs that touch routing, rendering, middleware,
  actions, revalidation, intercepts, prerender, or request-context propagation
- [Security checklist](./internal/security-checklist.md) - the checklist for
  changes that add or alter execution paths, transport behavior, or
  request/response ownership
- [Rendered barrier](./internal/rendered-barrier.md) - the experimental
  `await ctx.rendered()` loader barrier that lets a loader read handle data
  after the handler tree settles
- [Runtime guardrails design](./internal/runtime-guardrails-design.md) -
  dev-mode misuse warnings (warn, never silently fix): which guardrails
  shipped, which were removed, and why
- [include() and async route loading](./internal/async-includes.md) -
  the eager vs. async `() => import()` include forms and how discovery keeps
  the trie/reverse-map/type-gen/prerender invariants complete
- [Why SSR/RSC streaming uses Web Streams everywhere](./internal/why-web-streams-everywhere.md) -
  why both render layers use `renderToReadableStream` on Node
- [FILE_NAME_CONFLICT build warnings](./internal/file-name-conflict-warnings.md) -
  why the shared `onwarn` suppresses content-hashed asset re-emit collisions
  from `@vitejs/plugin-rsc`'s cross-environment copy

Completed, superseded, and point-in-time plan/handoff docs live in
[`internal/archive`](./internal/archive), and point-in-time review snapshots in
[`internal/reviews`](./internal/reviews). Both are kept for history and are not
maintained. Notable archived records:

- [Prerender passthrough action plan](./internal/archive/prerender-passthrough-action-plan.md) -
  the migration from `{ passthrough: true }` to the `Passthrough()` wrapper
- [Generated route type surfaces handoff](./internal/archive/generated-route-type-surfaces-handoff.md) -
  completed audit of the three generated type surfaces (`GeneratedRouteMap`,
  per-module `.gen.ts`, `RegisteredRoutes`) and response/MIME payload inference
- [Loader client refresh key handoff](./internal/archive/loader-client-refresh-key-handoff.md) -
  proposal for a hook-level client refresh key to partition `useLoader()` /
  `useFetchLoader()` `load()` fan-out
