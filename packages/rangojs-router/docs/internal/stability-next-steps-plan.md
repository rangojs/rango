# Stability Next Steps Plan

Date: 2026-03-10
Status: active
Owner: router maintainers

This document turns the current stability backlog into an execution plan for the
next cleanup pass. It is intentionally narrower than the full
`stability-roadmap.md`: the roadmap explains direction, while this file tracks
the concrete work that should happen next across tests, docs, skills, and
cleanup tasks.

## Goals

- Close the remaining high-signal production parity gaps.
- Keep docs and contributor skills aligned with the actual execution model.
- Reduce test and maintenance debt without reopening semantic design work.
- Leave a cleaner review surface than the current mix of partially stale plans.

## Non-Goals

- Add new router capabilities.
- Re-open settled prerender or middleware semantics.
- Build new warning systems unless a concrete regression requires one.

## Guiding Rule

The next pass should improve confidence and contributor ergonomics, not expand
surface area. Favor parity, clarity, and deletion over new abstraction.

## Workstreams

## 1. Contract-Critical Production Parity

Priority: highest

Target the specs that still represent core execution-model risk in build mode.

### 1A. Add Build Coverage For `handler-first.test.ts` — Done

Status: **complete**

Added production block covering ctx.set/get visibility to layout and parallel,
plus cache scope timestamp consistency test. Also added cloudflare-basic
handler-first test routes with dev + production coverage.

### 1B. Finish Build Parity For `app-middleware.test.ts` — Done

Status: **complete**

Added production coverage for cookie middleware (set/increment visit count) and
auth middleware with cookie (authenticated access). Intercept and loader
middleware documented as intentionally dev-only (intercept requires SPA context,
loader uses dev-specific query params).

### 1C. Finish Build Parity For Behavioral Parts Of `cache.test.ts` — Done

Status: **complete**

Added production coverage for cache-intercept-routes (modal rendering, loader
data visibility) and useLoader-with-loader-registration (direct navigation,
fresh data, intercept with loader). Cache key differentiation log assertions
and proactive caching log verification documented as intentionally dev-only
(cloudflare-basic has production coverage for the behavioral surface).

### 1D. Triage The Next Tier Of Dev-Only Specs — Done

Status: **complete**

Triage outcomes for all 6 candidates:

- `response-handler.test.ts` — production block added (17 tests)
- `handle-meta.test.ts` — production block added (18 tests)
- `route-resolution.test.ts` — production block added (10 tests)
- `streaming-actions.test.ts` — production block added (4 tests)
- `pending-actions.test.ts` — production block added (3 tests)
- `revalidation.test.ts` — explicitly deferred (RSC wire protocol internals;
  behavioral surface covered by navigation/caching/pending-actions production
  tests)

## 2. Docs Sync

Priority: high

The docs need one authoritative "what is next" entry point and fewer stale
claims.

### 2A. Keep The Roadmap High-Level

Tasks:

- Update `docs/internal/stability-roadmap.md` so the near-term checklist points
  at this execution plan.
- Keep the roadmap directional; do not duplicate detailed task lists there.

### 2B. Keep The Test Baseline Accurate

Tasks:

- Keep `docs/internal/test-quality-baseline.md` focused on measured inventory
  and backlog state.
- When production parity work lands, update only the affected sections instead
  of rewriting the whole baseline.

### 2C. Make Dev-Only vs Build-Parity Intent Explicit — Done

Status: **complete**

Dev-only annotations added inline in test files during the 1A-1D parity work:

- `cache.test.ts` — cache-intercept-routes and proactive-caching sections
  annotated with reasons (debug log assertions, cloudflare-basic coverage)
- `app-middleware.test.ts` — intercept and loader middleware sections annotated
  (SPA context requirement, dev-specific query params)
- `handler-first.test.ts` — revalidate/cache mix section annotated as
  intentionally dev-only (isolated server state, runtime cache semantics)
- `revalidation.test.ts` — file-level annotation explaining deferral rationale

## 3. Skill Updates

Priority: high

Contributor skills should reflect the current prerender model and maintenance
expectations, not just the original implementation shape.

### 3A. Refresh The `prerender` Skill

Tasks:

- Update `packages/rangojs-router/skills/prerender/SKILL.md` to reflect current
  semantics:
  - prerender is build-time cache, not asset output
  - `ctx.passthrough()` is implemented
  - loaders stay live by default
  - partial revalidation does not implicitly rebuild upstream prerender-derived
    context
- Add a contributor checklist for prerender changes:
  - docs to re-read before editing
  - tests that should be considered
  - when a behavior should remain dev-only vs build-parity

### 3B. Add A Maintenance Reference

Tasks:

- Point the skill at this plan and the test baseline so contributors see both
  semantic rules and active cleanup work.

Definition of done:

- A contributor opening the skill gets both the semantic model and the current
  maintenance expectations in one place.

## 4. Cleanup Pass

Priority: medium

These are not new features. They are the cleanup work that reduces future drift.

### 4A. Test Cleanup

Tasks:

- Continue removing fixed sleeps from `cache.test.ts`.
- Remove easy low-value duplication where dev and build blocks assert the same
  thing with unnecessary copy/paste.
- Prefer helper extraction only when it reduces maintenance noise without
  obscuring the contract under test.

### 4B. Plan Cleanup

Tasks:

- Mark older internal action plans as implemented, superseded, or still active.
- Avoid leaving "implemented but still written like pending work" docs around.
- Keep this plan as the active coordination doc until the current pass is done.

### 4C. Scope Cleanup

Tasks:

- Do not broaden this pass into new capability work.
- If a candidate task is really a new feature, move it back to roadmap-level
  discussion instead of mixing it into the cleanup queue.

Definition of done:

- The active backlog is smaller, more accurate, and easier to trust.

## Suggested Execution Order

1. `handler-first.test.ts` build coverage
2. `app-middleware.test.ts` remaining build parity
3. `cache.test.ts` behavioral build parity
4. docs sync after the first parity batch lands
5. `prerender` skill refresh
6. remaining backlog triage and cleanup sweep

## Verification

- Run targeted Playwright specs for every file touched in the parity pass.
- Keep `test:unit` green when changing shared runtime or test helpers.
- Re-run `e2e/semantic-matrix.test.ts` after any change that could affect core
  execution semantics.

## Exit Criteria

This plan is complete when:

- `handler-first.test.ts` is no longer dev-only.
- `app-middleware.test.ts` and `cache.test.ts` have their remaining meaningful
  production-parity gaps closed or explicitly documented as intentional.
- The roadmap, baseline, and prerender skill all point to the same current
  maintenance story.
- The active internal planning docs no longer overstate already-closed gaps.
