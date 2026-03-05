# Test Quality Full Review and Action Plan

Date: 2026-03-05
Owner: Router test quality initiative
Status: Proposed

Baseline execution reference: `docs/internal/test-quality-baseline.md`

## Goal

Improve test stability, correctness, and coverage with incremental, reviewable steps that can be implemented in separate PRs.

## Scope

- `packages/rangojs-router/src` unit and integration tests
- `packages/rangojs-router/e2e`
- `tests/cloudflare-basic/e2e`
- `tests/vite-rsc-demo/e2e`
- `tests/react-experimental/e2e`
- `examples/*/e2e` where helper behavior impacts reliability

## Current Snapshot

- Router unit test files: `77`
- Router e2e test files: `62`
- Cloudflare basic e2e test files: `31`
- Vite demo e2e test files: `13`
- React experimental e2e test files: `6`
- `waitForTimeout()` calls in router e2e: `66`
- `waitForTimeout()` calls across all e2e suites: `149`
- `test.skip(...)` markers across e2e: `3`
- `test.slow(...)` markers across e2e: `1`

Largest e2e files by line count:

- `tests/vite-rsc-demo/e2e/shop.test.ts` (`1923`)
- `packages/rangojs-router/e2e/navigation.test.ts` (`1536`)
- `packages/rangojs-router/e2e/cache.test.ts` (`1401`)
- `packages/rangojs-router/e2e/use-cache.test.ts` (`1301`)
- `packages/rangojs-router/e2e/use-loader-hooks.test.ts` (`995`)

## Key Findings

1. Synchronization debt is the primary flake risk.

- Many tests rely on fixed sleep intervals instead of deterministic signals.
- Sleep-heavy files cluster around cache, prefetch, navigation, and revalidation behavior.

2. Oversized specs reduce reliability and review quality.

- Multi-thousand-line test files combine multiple concerns and create cascade failures.

3. Helper behavior is duplicated across suites.

- Hydration wait and page error capture patterns diverge between projects.

4. Assertion strictness is inconsistent.

- Some tests still rely on permissive text visibility checks where ordering/count/negative assertions are safer.

5. Security-sensitive behavior needs explicit negative-path coverage.

- `routeParams` vs user-provided params boundaries
- malformed headers/URL parsing behavior
- cache-key isolation boundaries

## Guiding Principles

- Replace time-based waits with state/event-based waits.
- Prefer exact assertions over broad text matching.
- Keep each PR scoped to one objective and a small file set.
- Add tests for failure modes, not only happy paths.
- Preserve behavior while refactoring test structure.

## Workstream Plan

### Phase 0: Baseline and Instrumentation

Objective: establish a reproducible quality baseline before refactors.

Deliverables:

- `docs/internal/test-quality-baseline.md`
- file-level inventory of fixed sleeps, slow tests, skips, and long-running specs
- optional lightweight scripts under `scripts/test-quality/` for repeatability

Acceptance criteria:

- Baseline report can be regenerated locally using documented commands.
- Top flaky and high-cost targets are explicitly ranked.

### Phase 1: Deterministic Sync Refactor Wave A

Objective: remove highest-impact fixed sleeps in critical router suites.

Primary targets:

- `packages/rangojs-router/e2e/cache.test.ts`
- `tests/vite-rsc-demo/e2e/prefetch.test.ts`
- `tests/vite-rsc-demo/e2e/revalidation.test.ts`

Actions:

- Replace `waitForTimeout` with `expect.poll`, `toPass`, explicit URL transitions, request/response hooks, or DOM state transitions.
- Add local helper utilities only when reused by at least two tests.

Acceptance criteria:

- Significant sleep reduction in all three files.
- No decrease in assertion strictness.
- No new retries/timeouts used to “mask” instability.

### Phase 2: Deterministic Sync Refactor Wave B

Objective: extend deterministic synchronization to remaining sleep-heavy files.

Primary targets:

- `packages/rangojs-router/e2e/navigation.test.ts`
- `packages/rangojs-router/e2e/pending-actions.test.ts`
- `packages/rangojs-router/e2e/link-behavior.test.ts`
- `tests/vite-rsc-demo/e2e/shop.test.ts`
- `tests/vite-rsc-demo/e2e/kanban.test.ts`

Acceptance criteria:

- Most fixed sleeps removed from these targets.
- Each replacement tied to a concrete event or state signal.

### Phase 3: Assertion Hardening

Objective: reduce false positives.

Actions:

- Add order/count assertions for list-like UI (breadcrumbs, nav, cache states).
- Add negative assertions for stale state after transitions.
- Ensure intermediate states are asserted where behavior depends on streaming/pending.

Primary targets:

- `packages/rangojs-router/e2e/handle-meta.test.ts`
- `packages/rangojs-router/e2e/navigation.test.ts`
- `packages/rangojs-router/e2e/pending-actions.test.ts`
- `packages/rangojs-router/e2e/use-loader-hooks.test.ts`

Acceptance criteria:

- Critical tests validate both expected and forbidden states.
- Fewer “text exists somewhere” assertions in high-risk paths.

### Phase 4: Coverage Extension (Correctness + Security)

Objective: cover known blind spots and regression-prone boundaries.

Add or extend tests for:

- `ctx.routeParams` trust boundary vs merged `ctx.params`
- malformed URL/header behavior in match API flows
- cache key isolation by query and request type
- content negotiation and fallback behavior for partial/document requests
- revalidation edge behavior after actions

Acceptance criteria:

- Each new test maps to a documented risk.
- At least one negative-path test per risk category.

### Phase 5: Helper Unification

Objective: reduce drift in hydration/error handling semantics.

Actions:

- Standardize helper contracts across suites for hydration readiness wait.
- Standardize helper contracts across suites for page error capture.
- Standardize helper contracts across suites for `testId` locator helper.
- Keep project-specific behavior explicit when needed.

Acceptance criteria:

- Shared behavior documented once.
- Reduced duplicated logic and fewer helper divergences.

### Phase 6: Large Spec Decomposition

Objective: improve isolation, maintainability, and debug speed.

Primary decomposition targets:

- `tests/vite-rsc-demo/e2e/shop.test.ts`
- `packages/rangojs-router/e2e/navigation.test.ts`
- `packages/rangojs-router/e2e/use-cache.test.ts`

Actions:

- Split by domain scenario (`navigation-core`, `navigation-intercept`, `cache-hit-miss`, etc.).
- Preserve test intent and coverage while reducing cross-test coupling.

Acceptance criteria:

- Smaller focused files with clearer ownership boundaries.
- Failures localize to narrower scenarios.

### Phase 7: CI Reliability and Lane Strategy

Objective: faster and more predictable feedback loops.

Actions:

- Define a pre-merge critical lane and an exhaustive lane.
- Tune worker count and serial zones by measured contention.
- Keep HMR/file-mutating tests isolated.

Acceptance criteria:

- Reduced variance in CI runtime.
- Lower flaky retry rate on core PR paths.

## Execution Order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7

## Per-PR Implementation Contract

For each step, implementation should provide:

- Objective and scope
- Changed files
- Why synchronization/assertion changes are behavior-preserving
- Commands run
- Test results summary
- Known tradeoffs

## Review Contract

Review checks should prioritize:

1. Behavioral regression risk
2. False positives/false negatives in assertions
3. Flake risk introduced or removed
4. Missing tests for security/correctness boundaries
5. Maintainability and readability

If no blocking findings are present, proceed to next phase.

## Suggested First Ticket

Start with Phase 0, then Phase 1 on:

- `packages/rangojs-router/e2e/cache.test.ts`

Reason: high sleep density, high value, low blast radius.
