# Async render stages POC

This note maps the current render responsibilities to the async-generator POC.
The goal is to make the refactor easy to evaluate: each stage should have a
clear owner, a pause point you can step in tests, and evidence that it reduces
branching or duplication without changing the React tree.

## Objective

Use async generators only where they make the render flow easier to reason
about:

- step through observable phases (`payload` -> `flight` -> optional `html` ->
  response)
- let callers resume with controlled data (`next({ payload })`,
  `next({ body, init })`)
- delegate subflows with `yield*` where a phase has its own work and evidence
  hooks
- carry explicit stage context (`mode`, route/action ids, progress, phase timing)
  so analytics can be collected without rediscovering where the render is
- observe HTML/SSR progress without replacing the existing `PHASES.ssr` span
  boundary or Server-Timing behavior
- centralize repeated Flight serialization/error/metric plumbing
- keep matching, segment resolution, and `renderSegments()` tree structure
  unchanged

## Mapping

| Existing responsibility                     | Current owner                                                     | Stage mapping                                                                                                                         | Status    |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Route matching / partial matching           | `rsc-rendering.ts`, `server-action.ts`                            | Stays outside the generator. Matching still decides full vs partial payload shape before stages start.                                | Unchanged |
| Transition gating                           | `gateTransitions()` at each payload builder                       | Stays before `payload`; the stage receives already-gated segments.                                                                    | Unchanged |
| Payload inspection / last-mile mutation     | Inline locals before `renderToReadableStream()`                   | `payload` yield from `createRscRenderStages()`. Tests can inspect or replace the `RscPayload` with `next({ payload })`.               | POC       |
| Flight serialization                        | Inline `ctx.renderToReadableStream()` blocks                      | `flight` stage owns `renderToReadableStream` and render `onError`; the common generator keeps the existing `rsc-serialize` metric.    | POC       |
| Flight subflow delegation                   | Implicit inline block                                             | `createRscRenderStages()` delegates to the Flight sub-generator with `yield*`, so Flight can own timing/error events.                 | POC       |
| Flight-only render sites                    | Redirect, 404, PPR tail, shell capture inline Flight calls        | `renderRscFlightStage()` shares Flight timing/error plumbing without taking response or capture ownership; metrics are caller opt-in. | POC       |
| Raw Flight response                         | Inline `createResponseWithMergedHeaders(rscStream, init)`         | `runRscRenderStages()` drains the generator to its final `Response`.                                                                  | POC       |
| HTML response                               | Inline Flight stream -> `ssrModule.renderHTML()` -> HTML response | Caller pauses at `flight`, observes HTML with `observeRscHtmlStage()`, then resumes with `next({ body, init })`.                      | POC       |
| Analytics/progress context                  | Scattered phase-local values                                      | `tracking.phases` declares the per-path phase list, then events report phase/progress/context from that list.                         | POC       |
| Debug stage logging                         | Ad hoc console/debug statements                                   | `createRscStageDebugSink()` adapts stage events to structured debug logs; callers opt in explicitly.                                  | POC       |
| Early SSR setup / parallel work             | `handler.ts` starts SSR setup before render consumption           | Stays outside the generator; stages can observe later render progress without owning the early parallel kickoff.                      | Unchanged |
| Action temporary references                 | `server-action.ts` render options                                 | Passed through stage input to the shared Flight serialization point.                                                                  | POC       |
| PPR shell HIT/MISS policy                   | `rsc-rendering.ts` before normal render                           | Stays outside the generator for this POC; it has separate commit/capture semantics.                                                   | Unchanged |
| Progressive enhancement rerender/error HTML | `progressive-enhancement.ts`                                      | Same `flight` pause + HTML resume as the normal SSR path.                                                                             | POC       |
| Browser segment merge and commit            | `browser/partial-update.ts`, `server-action-bridge.ts`            | Do not broadly stage. These paths protect client tree identity and have separate abort/transaction semantics.                         | Unchanged |
| React tree assembly                         | `segment-system.tsx`                                              | Not part of this POC. Wrapper/key rules from `docs/tree-structure.md` remain untouched.                                               | Unchanged |

## Evidence checklist

| Question                                    | Evidence to collect                                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did behavior stay the same?                 | Existing `rsc/__tests__/performance.test.ts`, `action-revalidate-trace.test.ts`, and `server-action.test.ts` stay green.                                                                                          |
| Can we step and control flow?               | `rsc/__tests__/render-stages.test.ts` steps `payload -> flight -> response`, resumes with a replacement payload and HTML body, and pins thrown serialization at the Flight step.                                  |
| Can we collect phase context?               | `render-stages.test.ts` captures stage events and asserts ordered phases, path-owned progress counters, mode, route key, action id, pathname, Flight error events, and debug-sink output.                         |
| Did complexity move in the right direction? | Compare repeated `renderToReadableStream` + `appendMetric` + response blocks before/after. Count touched LOC and remaining branch points in `rsc-rendering.ts` and `server-action.ts`.                            |
| Did performance regress?                    | Compare three signals: synthetic stage-control overhead, local stress-app throughput, and Server-Timing/metrics shape. Treat local stress numbers as directional unless both sides are same-day clean-tree runs.  |
| Did debug/OTel stay correct?                | Keep `PHASES.render` and `PHASES.ssr` as the only phase-span owners. Stage events are progress/debug facts; they must not duplicate `rango.render`/`rango.ssr` spans or require `debugPerformance` to be enabled. |
| Is the abstraction balanced?                | Keep only if at least two render paths share it cleanly and stage guards make the flow more explicit. Revert or narrow if callers need path-specific escape hatches.                                              |

## Current read

This POC deliberately starts below matching and above transport finalization.
That is the smallest useful slice: it avoids the high-risk segment tree rules
while still touching navigation/full rendering, action revalidation, and
progressive-enhancement HTML rerenders.

## Initial POC evidence

- Behavior: `src/rsc/__tests__` passes after the refactor (32 files, 350 tests),
  including PPR shell HIT/MISS and progressive-enhancement coverage.
- Step control: `render-stages.test.ts` manually advances `payload -> flight ->
response`, replaces the payload with `next({ payload })`, resumes the HTML
  response with `next({ body, init })`, and proves synchronous Flight
  serialization failures surface at the Flight step.
- Context/progress: stage tracking now emits ordered `stage:*` events with
  mode, route key, action id, pathname, phase progress, timing, and synchronous
  Flight error records. Progress is derived from a per-path phase list such as
  `RSC_RENDER_HTML_RESPONSE_PHASES`, `RSC_FLIGHT_ONLY_PHASES`, or
  `RSC_FLIGHT_HTML_PHASES`; the Flight phase is delegated with `yield*` so its
  timing and error events live with the work they describe.
- HTML/debug: HTML renders are observed as additive events around the existing
  SSR work, dynamic progress totals distinguish `payload -> flight -> response`
  from `payload -> flight -> html -> response`, and the debug sink translates
  events to structured logs without making analytics load-bearing.
- Duplication: `server-action.ts` dropped from four inline
  `renderToReadableStream<RscPayload>` / `rsc-serialize` occurrences to zero,
  and `progressive-enhancement.ts` dropped from two to zero. `rsc-rendering.ts`
  and `shell-capture.ts` now share the Flight-only helper for PPR tail/capture
  Flight construction. The only remaining direct `renderToReadableStream<RscPayload>`
  is the defensive redirect fallback when no request context is available.
- Diff shape: this is not yet a total LOC reduction. The helper adds the shared
  stage API, `server-action.ts` gets smaller, and `rsc-rendering.ts` grows a
  little because it now makes the Flight pause explicit before SSR.
- Review follow-up: direct Flight helpers now preserve the old metric surface
  unless the caller passes `recordSerializeMetric: true`, so redirect and 404
  Flight responses do not gain a debug-only `rsc-serialize` metric by accident.
  `render-stages.test.ts` pins both this opt-in and the 404-style
  `flight -> html` progress sequence.
- Performance smoke signal: a Node control-flow micro-benchmark over 7 x 50,000
  iterations measured inline at `1.525us/op` median and staged at
  `3.008us/op` median, or `+1.483us/op`. That is an overhead to keep visible,
  not a speedup claim; real render work still dominates by orders of magnitude.

## Telemetry guardrails

The stage API is not a new tracing model. It sits underneath the existing
`observePhase(PHASES.render)` and `observePhase(PHASES.ssr)` boundaries in
`src/router/instrument.ts`, which still own both `debugPerformance` metrics and
OTel/Cloudflare phase spans. That keeps the router's one-owner rule intact:
`rango.render` and `rango.ssr` are callback-bound spans around real work, not
reconstructed from after-the-fact start/end events.

Stage events should stay opt-in facts for debugging and analytics. The current
POC routes them through `tracking.onEvent`, and `createRscStageDebugSink()` is
only an adapter from those facts to structured debug logs. A future telemetry
adapter may map completed/error stage facts to the `TelemetrySink`, but it
should remain a discrete-fact surface like cache decisions or timeouts, never a
second phase-span source.

This also protects the default performance path: if no `tracking.onEvent` is
provided, stage event emission returns before building event payloads; it does
not enable `debugPerformance`, allocate telemetry events, or touch OTel. The
generator still builds the context objects that are part of the stepped stage
contract, but HTML/response observer contexts are now lazy when no sink exists.

Metric ownership is deliberately narrower than the first draft: the common
`createRscRenderStages()` path records the same `rsc-serialize` metric it
replaced, while direct `renderRscFlightStage()` callers record it only when they
explicitly pass `recordSerializeMetric: true`. That keeps redirect, 404, PPR
tail, and shell-capture surfaces from gaining new debug-only timings just
because they share Flight construction.

## Performance comparison

The current evidence says "small abstraction overhead, no reproduced app-level
regression." That is still a useful answer: the POC is paying for itself in
steppability and instrumentation consistency, not in raw request throughput.

| Signal                   | Baseline / inline                                                     | Branch / staged                                                     | Read                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic render control | Inline stream -> response: `1.525us/op` median                        | Async stage pipeline: `3.008us/op` median                           | `+1.483us/op`; measurable in a tight loop, too small to matter beside React Flight/SSR but not zero.                                               |
| Clean stress throughput  | `95f5648c` (`origin/main`), `bench-2026-07-08-95f5648c.json`          | `75c34373`, `bench-2026-07-08-75c34373.json`                        | No reproduced drop. All render-heavy scenarios were within variance; `cached-hit` was the only significant change and it improved `176 -> 227`.    |
| Clean cold starts        | Same July 8 run, 3 cold starts                                        | Same July 8 run, 3 cold starts                                      | Render-entry paths stayed flat: `/app/dashboard/main` `12.2ms -> 12.1ms`, `/` `6.3ms -> 6.1ms`, `/site/en/bench/first` `14.8ms -> 15.2ms`.         |
| Clean stress memory      | Peak RSS `4109 MB`, workerd peak `2200 MB`                            | Peak RSS `4139 MB`, workerd peak `2195 MB`                          | Flat for this harness. The `30 MB` process-group RSS delta is below the noise floor of local wrangler/workerd runs.                                |
| Server-Timing shape      | `rsc-serialize` present on common render paths, mostly `0.0ms` median | Same common-path shape; direct redirect/404 helper metric is opt-in | The review's metric pollution concern is fixed; current timings do not show a visible serialize regression.                                        |
| Earlier stress run       | `e533fc83`, July 4 saved baseline                                     | `e7f659e9` dirty branch, July 7 saved run                           | Retired as regression evidence. It mixed dates, commits, and dirty-tree state; its drops also hit JSON/API paths outside the staged render change. |

Commands used for the clean A/B:

```sh
./node_modules/.bin/tsx bench/run.ts --runs 3 --duration 2 --cold-runs 3
./node_modules/.bin/tsx bench/compare.ts \
  bench/results/bench-2026-07-08-95f5648c.json \
  bench/results/bench-2026-07-08-75c34373.json
```

The practical performance status is: keep the generator layer scoped to render
work, keep event construction lazy, and treat the synthetic `+1.483us/op` as the
cost to watch if this expands beyond RSC rendering. The stress-app drops from
the older comparison did not reproduce against current `origin/main`.

## External app validation

The first real-app pass used two Cloudflare Workers apps that exercise different
parts of the render pipeline:

| App                      | Why it matters                                                                                                                      | Result                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rsc-cloudflare-app`     | Multi-router Cloudflare app with `createCloudflareTracing()`, `ctx.debugPerformance()`, PPR store routes, `Prerender()` categories. | Branch-linked typecheck passed; branch-linked `vite build` passed and emitted stage code in the RSC handler chunks.                              |
| `cloudflare-stress-demo` | 26k+ route Cloudflare stress app with SSR, Flight partials, cache segments, PE action POST, async includes, and benchmark routes.   | Typecheck passed; `vite build` passed; production e2e smoke passed; deployed version responds with document, dashboard, JSON, and Flight routes. |
| `tests/cloudflare-basic` | Consumer dogfood for tracing, telemetry, dispatch, Flight serialization, and server-tree rendering.                                 | Focused unit/RSC tests passed: tracing/telemetry/dispatch `10` tests, Flight/server-tree `10` tests.                                             |

Concrete commands run:

```sh
# rsc-cloudflare-app, first on installed router 0.0.0-experimental.146,
# then with node_modules/@rangojs/router temporarily linked to this branch.
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p src/apps/admin/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/apps/site/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/apps/site-database/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/apps/store/tsconfig.json
./node_modules/.bin/vite build

# cloudflare-stress-demo
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p bench --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/playwright test --project=production --no-deps --grep "app load surface \(production\)|async include routes \(production\)"

# cloudflare-basic
./node_modules/.bin/vitest run test/tracing.test.ts test/telemetry-emission.test.ts test/dispatch.test.ts
./node_modules/.bin/vitest run --config vitest.rsc.config.ts test/flight.rsc-test.tsx test/server-tree.rsc-test.tsx
```

Deployment evidence:

| App                      | URL                                                    | Version                                |
| ------------------------ | ------------------------------------------------------ | -------------------------------------- |
| `cloudflare-stress-demo` | `https://cloudflare-stress-demo.devcorner.workers.dev` | `8f9d2f30-5b34-4ec8-9afd-f103e8166fa6` |
| `rsc-cloudflare-app`     | `https://rsc-cloudflare-app.devcorner.workers.dev`     | `72aed050-1087-4967-9845-aae02d53996c` |
| `rsc-cloudflare-app`     | `https://rsc.devcorner.com`                            | same deployed Worker version           |

Live smoke after deploy:

- `cloudflare-stress-demo` returned `200` for `/`, `/app/dashboard/main`,
  `/api/bench/first`, and the Flight partial route
  `/site/en/flat/1?_rsc_partial=true&_rsc_segments=` with
  `content-type: text/x-component`.
- `rsc-cloudflare-app` returned `200` for `/` and `/shop` on both workers.dev
  and `rsc.devcorner.com`; `/shop` included `rsc-serialize`,
  `ssr-render-html`, `render-total-home`, and `x-rango-shell: MISS` in the
  response headers.

Two caveats matter:

- `rsc-cloudflare-app` was installed on `@rangojs/router@0.0.0-experimental.146`.
  The branch-linked validation exercised this branch (`0.0.0-experimental.150`
  plus the POC commits), so differences from the app's baseline include both
  the version jump and the async-stage POC.
- Branch-linked `rsc-cloudflare-app` build generated prerender assets
  successfully (`6130.4 KB`, `279` entries). Seven prerender URLs were skipped
  under `prerender.onError: "warn"` because the upstream Commerce API returned
  `504 Gateway Timeout`; the build continued and deployed. The same
  shell-prerender mismatch remained: generated `/shop/...` shell paths did not
  match runtime routes, so shell rows stayed on runtime capture. The
  installed-router baseline wrote prerender assets too (`6284.4 KB`, `285`
  entries) and did not run that shell-prerender reporting path, so this is a
  version-delta observation to investigate separately, not evidence against
  async render stages.

The next re-evaluation point is NOT a broad client-side generator. The
partial-update/action bridge audit found that those branches are mostly semantic
locks: repeated abort checks after awaits, transaction commit ordering,
cache-before-update ordering, transition policy differences, and
never-settling redirect/reload terminals. A future client cleanup should start
with a pure reconcile-plan helper, not an async generator.
