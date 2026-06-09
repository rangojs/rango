> **Archived.** Execution plan complete (all workstreams done).

# Stability Next Steps Plan

Date: 2026-03-10
Status: complete
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

Added production coverage for cookie middleware (set/increment visit count),
auth middleware with cookie (authenticated access), intercept middleware
(header setting and cookie on SPA modal navigation), and loader middleware
(authorization reject/allow/reject-invalid via production hashed loader IDs).
No remaining dev-only section in `app-middleware.test.ts`.

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

### 2A. Keep The Roadmap High-Level — Done

Status: **complete**

Roadmap near-term checklist updated to note production parity gaps are closed
and to point at this execution plan. No detailed task lists duplicated there.

### 2B. Keep The Test Baseline Accurate — Done

Status: **complete**

Baseline updated incrementally as each parity batch landed: production coverage
gaps section reflects all 1A-1D work, sleep inventory notes pending-actions
signal replacement, and app-middleware partial coverage description corrected.

### 2C. Make Dev-Only vs Build-Parity Intent Explicit — Done

Status: **complete**

Dev-only annotations added inline in test files during the 1A-1D parity work:

- `cache.test.ts` — cache-intercept-routes and proactive-caching sections
  annotated with reasons (debug log assertions, cloudflare-basic coverage)
- `app-middleware.test.ts` — intercept and loader middleware now have
  production tests (original annotations were inaccurate and removed).
- `handler-first.test.ts` — revalidate/cache mix section annotated as
  intentionally dev-only (isolated server state, runtime cache semantics)
- `revalidation.test.ts` — file-level annotation explaining deferral rationale

## 3. Skill Updates

Priority: high

Contributor skills should reflect the current prerender model and maintenance
expectations, not just the original implementation shape.

### 3A. Refresh The `prerender` Skill — Done

Status: **complete**

The skill's semantic content was already accurate (build-time cache model,
passthrough, ctx.passthrough(), live loaders, partial revalidation caveat).
Added a "Contributor Checklist" section with docs to re-read, tests to run,
and dev-only vs build-parity guidance.

### 3B. Add A Maintenance Reference — Done

Status: **complete**

Added a "Maintenance References" section pointing at the stability next steps
plan and test quality baseline. A contributor opening the skill now gets
semantic rules, test commands, and the active cleanup context in one place.

## 4. Cleanup Pass

Priority: medium

These are not new features. They are the cleanup work that reduces future drift.

### 4A. Test Cleanup — Done

Status: **complete**

Fixed sleeps in `cache.test.ts` were already removed (A1 from the baseline).
Fixed sleeps in `pending-actions.test.ts` production block replaced with
network-level signals during the 1D fix pass. No remaining low-value
duplication found in the parity blocks — each dev/production section tests
mode-specific concerns (e.g., error message sanitization, hashed loader IDs).

### 4B. Plan Cleanup — Done

Status: **complete**

Added status markers to all stale internal planning docs:

- `prerender-passthrough-action-plan.md` — already marked "Implemented"
- `test-quality-full-review-action-plan.md` — marked "Superseded" by this plan
- `non-test-review-actions.md` — marked "Implemented" (F1-F3 addressed)
- `prefetch-review-actions.md` — marked "Implemented" (origin validation done)
- `scroll-location-review-actions.md` — marked "Implemented" (cleanup + quota)
- `runtime-guardrails-design.md` — marked "Partial" (W3 shipped,
  W1 removed as noise, W2 reframed, W4/W6 deferred)
- `cache-dsl-use-cache-remediation-plan.md` — marked "Implemented"

### 4C. Scope Cleanup

No new capability work was mixed into this pass. All changes stayed within
the parity, docs, skill, and cleanup scope defined in sections 1-4.

## Suggested Execution Order — Complete

All items executed:

1. `handler-first.test.ts` build coverage — done (1A)
2. `app-middleware.test.ts` remaining build parity — done (1B)
3. `cache.test.ts` behavioral build parity — done (1C)
4. docs sync after the first parity batch lands — done (2A-2C)
5. `prerender` skill refresh — done (3A-3B)
6. remaining backlog triage and cleanup sweep — done (4A-4B)

## Verification

- Run targeted Playwright specs for every file touched in the parity pass.
- Keep `test:unit` green when changing shared runtime or test helpers.
- Re-run `e2e/semantic-matrix.test.ts` after any change that could affect core
  execution semantics.

## Exit Criteria — Met

- `handler-first.test.ts` is no longer dev-only. **Done.**
- `app-middleware.test.ts` and `cache.test.ts` have their remaining meaningful
  production-parity gaps closed or explicitly documented as intentional. **Done.**
- The roadmap, baseline, and prerender skill all point to the same current
  maintenance story. **Done.**
- The active internal planning docs no longer overstate already-closed gaps.
  **Done.**
