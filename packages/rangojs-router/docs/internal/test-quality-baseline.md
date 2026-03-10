# Test Quality Baseline (Executed) and Action Backlog

Date: 2026-03-10 (updated)
Status: Detailed inventory complete

Note: this document started as a 2026-03-05 executed baseline. The production
coverage section and backlog notes below were refreshed on 2026-03-10 after
subsequent stabilization work landed.

## Purpose

Capture an executed baseline for test quality and define an actionable, implementation-ready backlog for stability, correctness, and coverage improvements.

## Scope

- `packages/rangojs-router/src` tests
- `packages/rangojs-router/e2e`
- `tests/cloudflare-basic/e2e`
- `tests/vite-rsc-demo/e2e`
- `tests/react-experimental/e2e`

## Baseline Snapshot

Test inventory:

- Router unit test files: `76`
- Router e2e test files: `62`
- Cloudflare basic e2e test files: `31`
- Vite demo e2e test files: `13`
- React experimental e2e test files: `6`
- **Grand total**: `102` e2e test files, `37,509` lines

Synchronization debt:

- `waitForTimeout()` calls in router e2e: `66`
- `waitForTimeout()` calls across all e2e suites: `149`
- `test.skip(...)` markers: `2` (both in route-types-hmr.test.ts)
- `test.slow(...)` markers: `1` (handle-breadcrumbs.test.ts)

## Detailed Sleep Inventory (by file, descending)

| File                                              | Count  | Timeout values | Context                       |
| ------------------------------------------------- | ------ | -------------- | ----------------------------- |
| rangojs-router/e2e/cache.test.ts                  | 18     | 500ms (all)    | cache write completion        |
| vite-rsc-demo/e2e/prefetch.test.ts                | 17     | 200-500ms      | prefetch request timing       |
| vite-rsc-demo/e2e/revalidation.test.ts            | 14     | 1000-3000ms    | server revalidation           |
| vite-rsc-demo/e2e/shop.test.ts                    | 13     | 300-5000ms     | cart operations, actions      |
| vite-rsc-demo/e2e/kanban.test.ts                  | 12     | 100-6000ms     | drag-drop, action processing  |
| rangojs-router/e2e/link-behavior.test.ts          | 8      | 200-2000ms     | prefetch cache, link behavior |
| rangojs-router/e2e/pending-actions.test.ts        | 7      | 600-4000ms     | pending UI states             |
| vite-rsc-demo/e2e/todos.test.ts                   | 6      | 100-10000ms    | concurrent todo actions       |
| rangojs-router/e2e/navigation.test.ts             | 5      | 500-600ms      | navigation state sync         |
| cloudflare-basic/e2e/api-route-navigation.test.ts | 4      | 200-600ms      | API route nav                 |
| rangojs-router/e2e/loader-types-basic.test.ts     | 4      | 500ms (all)    | cache writes                  |
| rangojs-router/e2e/cache-status.test.ts           | 4      | 500ms (all)    | cache status headers          |
| vite-rsc-demo/e2e/scroll-restoration.test.ts      | 3      | 100ms (all)    | scroll position sync          |
| rangojs-router/e2e/revalidation.test.ts           | 3      | 600-2000ms     | action revalidation           |
| rangojs-router/e2e/loader-behavior.test.ts        | 3      | 100ms (all)    | loader execution              |
| cloudflare-basic/e2e/cache.test.ts                | 2      | 150-1000ms     | cache operations              |
| cloudflare-basic/e2e/blog-cache.test.ts           | 2      | 500ms (both)   | blog cache writes             |
| rangojs-router/e2e/streaming-actions.test.ts      | 2      | 600ms (both)   | streaming completion          |
| rangojs-router/e2e/on-error.test.ts               | 2      | 1000ms (both)  | error propagation             |
| rangojs-router/e2e/hooks.test.ts                  | 2      | 100-500ms      | hook behavior                 |
| vite-rsc-demo/e2e/history-cache.test.ts           | 2      | 300-500ms      | history cache                 |
| + 12 more files                                   | 1 each | various        | various                       |

Timeout value distribution (149 total):

- 100ms: 15 calls (hydration, rapid test isolation)
- 200ms: 9 calls (browser cache, HMR)
- 300ms: 6 calls (prefetch dedup)
- **500ms: 34 calls** (most common — async cache writes)
- 600ms: 8 calls (action processing)
- 1000ms: 12 calls (revalidation, error completion)
- 2000ms: 10 calls (cache invalidation, complex flows)
- 3000ms+: 11 calls (concurrent ops, action races)

## Largest Specs by Line Count

Router e2e (top 10):

| File                     | Lines |
| ------------------------ | ----- |
| navigation.test.ts       | 1,536 |
| cache.test.ts            | 1,624 |
| use-cache.test.ts        | 1,301 |
| use-loader-hooks.test.ts | 995   |
| location-state.test.ts   | 952   |
| mw-chain.test.ts         | 936   |
| app-middleware.test.ts   | 820   |
| handle-meta.test.ts      | 1,097 |
| prerender.test.ts        | 630   |
| use-router.test.ts       | 614   |

Cross-suite (top 5):

| File                                    | Lines |
| --------------------------------------- | ----- |
| vite-rsc-demo/shop.test.ts              | 1,923 |
| rangojs-router/navigation.test.ts       | 1,536 |
| rangojs-router/cache.test.ts            | 1,401 |
| rangojs-router/use-cache.test.ts        | 1,301 |
| rangojs-router/use-loader-hooks.test.ts | 995   |

## Production Coverage Gaps

Router e2e files with no explicit production coverage (`mode: "build"` block or
`(production)` suite):

**18 files** currently lack explicit production coverage. Most are lower-signal
or intentionally dev-focused:

- `theme.test.ts`
- `transform-cases.test.ts`
- `include-middleware.test.ts`
- `navigation-loading.test.ts`
- `navigation-hooks.test.ts`
- `handle-breadcrumbs.test.ts`
- `cache-status.test.ts`
- `als-scope.test.ts`
- `api-client.test.ts`
- `reverse-fallback.test.ts`

Explicitly deferred (production parity not planned):

- `revalidation.test.ts` — tests RSC wire protocol internals (request headers,
  segment IDs); behavioral surface covered by navigation/caching/pending-actions
  production tests

Intentionally dev-only by design:

- HMR tests (`client-component-hmr.test.ts`, `intercept-hmr.test.ts`,
  `loader-hmr.test.ts`, `route-types-hmr.test.ts`)
- `bundle-analysis.test.ts`
- `connection-warmup.test.ts`
- `hydration-detection.test.ts`
- `semantic-matrix.test.ts`

Partially covered — remaining dev-only subsections are documented:

- `cache.test.ts` — production covers loader/status/response-type/intercept
  behavioral/useLoader cases. Remaining dev-only: cache key differentiation log
  assertions, proactive caching log verification (behavioral surface covered by
  cloudflare-basic production tests)
- `app-middleware.test.ts` — production covers core middleware, redirects,
  short-circuit, W5 behavior, cookies, and auth. Remaining dev-only: intercept
  middleware (requires SPA context), loader middleware (uses dev-specific query
  params)

Production coverage gaps closed during the 2026-03-10 stabilization pass:

- `handler-first.test.ts` — handler-first execution order (ctx.set/get, cache
  scope)
- `handle-meta.test.ts` — meta tags, SSR, templates, unset, merging,
  passthrough
- `pending-actions.test.ts` — action robustness during navigation
- `response-handler.test.ts` — auto-wrap, headers, cookies, middleware, layout
- `route-resolution.test.ts` — trailing slash config, dynamic segments, SPA nav
- `streaming-actions.test.ts` — streaming actions, form patterns
- `cache.test.ts` (intercept behavioral, useLoader registration)
- `app-middleware.test.ts` (cookie, auth middleware)

Production coverage gaps closed after the original snapshot (pre-2026-03-10):

- `use-cache.test.ts`
- `mw-chain.test.ts`
- `response-cache.test.ts`
- `loader-cookie.test.ts`

Files with production-only coverage (inverted gap):

- `action-id-resolution.test.ts`

## Helper Divergence

Core functions duplicated across 4+ helpers:
`testId`, `clickAndWaitFor`, `expectNoPageError`, `waitForNavigation`, `goBack`, `expectNoReload`, `waitForHydration`

Key divergences:

| Function         | rangojs-router       | cloudflare/react-exp | vite-rsc-demo           |
| ---------------- | -------------------- | -------------------- | ----------------------- |
| waitForHydration | `data-hydrated` attr | `__reactFiber` check | `__reactFiber` + poll   |
| goBack           | `page.goBack()`      | `page.goBack()`      | `window.history.back()` |
| expectNoReload   | DOM marker           | Network monitoring   | DOM marker              |

## Test Skip/Slow Markers

- `route-types-hmr.test.ts:31` — `test.skip()` on describe block: "file watcher unreliable on CI"
- `route-types-hmr.test.ts:98` — `test.skip()` in beforeEach: skip if uncommitted source changes
- `handle-breadcrumbs.test.ts:264` — `test.slow()`: action revalidation test needs longer timeout

## Repeat-Run Results (Flake Sampling)

1. `packages/rangojs-router/e2e/cache.test.ts`

- Command: `--project=dev --no-deps --repeat-each=2`
- Result: `52 passed (40.7s)` — no flakes

2. `tests/vite-rsc-demo/e2e/prefetch.test.ts`

- Command: `--project=dev --no-deps --repeat-each=2`
- Result: `30 passed (21.5s)` — no flakes

3. `tests/vite-rsc-demo/e2e/revalidation.test.ts`

- Command: `--project=dev --no-deps --repeat-each=2`
- Result: `8 passed (25.0s)` — no flakes

## Prioritized Action Backlog

## A1: Remove Fixed Sleeps in `cache.test.ts`

Objective: Replace deterministic-delay assumptions with event/state polling.

Files:

- `packages/rangojs-router/e2e/cache.test.ts`

The 18 sleeps all use 500ms to wait for async cache writes. Replace with
polling on cache status indicators or request lifecycle signals.

Definition of done:

- Fixed sleeps removed where behavior can be observed via logs, DOM, or request lifecycle.
- Assertions remain at least as strict as current.
- Test file remains green in `dev` project and no-deps mode.

Verification:

- `pnpm --filter @rangojs/router exec playwright test --project=dev --no-deps e2e/cache.test.ts`
- `pnpm --filter @rangojs/router exec playwright test --project=dev --no-deps --repeat-each=3 e2e/cache.test.ts`

## A2: Remove Fixed Sleeps in Prefetch/Revalidation

Objective: Eliminate fixed waits in high-frequency timing tests.

Files:

- `tests/vite-rsc-demo/e2e/prefetch.test.ts` (17 sleeps)
- `tests/vite-rsc-demo/e2e/revalidation.test.ts` (14 sleeps)

## A3: Finish Remaining Production Coverage Parity — Done

Status: **complete** (2026-03-10)

All high-signal production parity gaps have been closed or explicitly triaged.
See the stability-next-steps-plan.md items 1A-1D for the full execution log.

Files covered:

- `handler-first.test.ts` — production block added
- `cache.test.ts` — intercept behavioral + useLoader production blocks added;
  log-based and proactive caching tests documented as intentionally dev-only
- `app-middleware.test.ts` — cookie + auth middleware production blocks added;
  intercept + loader middleware documented as intentionally dev-only
- `response-handler.test.ts` — full production mirror
- `handle-meta.test.ts` — high-signal production subset
- `route-resolution.test.ts` — production block added
- `streaming-actions.test.ts` — production block added
- `pending-actions.test.ts` — production block added
- `revalidation.test.ts` — explicitly deferred (wire protocol internals)

## A4: Assertion Hardening in High-Risk Router Specs

Objective: Reduce false positives by validating order/count/negative paths.

Files:

- `packages/rangojs-router/e2e/navigation.test.ts`
- `packages/rangojs-router/e2e/pending-actions.test.ts`
- `packages/rangojs-router/e2e/handle-meta.test.ts`
- `packages/rangojs-router/e2e/use-loader-hooks.test.ts`

## A5: Security and Boundary Coverage Expansion

Targets:

- `ctx.routeParams` trust boundary vs merged `ctx.params`
- malformed URL/header handling in match API
- cache-key isolation by query/request type
- partial/document content negotiation fallback paths

Status: Partially done in PR #280 (cache key tests, routeParams test, URL parsing hardening).

## A6: Helper Unification

Targets: all `e2e/helper.ts` files

## A7: Spec Decomposition for Maintainability

Targets:

- `tests/vite-rsc-demo/e2e/shop.test.ts` (1,923 lines)
- `packages/rangojs-router/e2e/navigation.test.ts` (1,536 lines)
- `packages/rangojs-router/e2e/use-cache.test.ts` (1,301 lines)

## A8: CI Lane Optimization

Targets: Playwright project/lane strategy

## Execution Order

1. A1 (highest impact, lowest blast radius)
2. A2
3. A3
4. A4
5. A5
6. A6
7. A7
8. A8
