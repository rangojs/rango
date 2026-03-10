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

### 1A. Add Build Coverage For `handler-first.test.ts`

Why:

- It exercises a core contract: handler-established context must remain visible
  to downstream layouts/parallels during a full render.
- It is still fully dev-only.

Tasks:

- Add a `mode: "build"` block to
  `packages/rangojs-router/e2e/handler-first.test.ts`.
- Cover the two highest-signal assertions:
  - handler `ctx.set()` visible to layout/orphan consumer
  - handler `ctx.set()` visible to parallel consumer
- Add one build-mode cache/revalidate assertion only if it remains stable and
  worth the runtime cost. Do not mirror every dev test by default.

Definition of done:

- The file has explicit build coverage for the contract it is named after.
- The production tests pass without relying on fixed sleeps.

### 1B. Finish Build Parity For `app-middleware.test.ts`

Why:

- Middleware remains one of the highest-complexity surfaces.
- Current build coverage is good but incomplete in exactly the places that are
  easy to regress: cookies, intercepts, loader fetch paths.

Tasks:

- Add build-mode coverage for the remaining dev-only sections:
  - cookie middleware
  - intercept middleware
  - loader middleware
- Keep the production subset focused on contract behavior, not exhaustive
  duplication of every dev assertion.

Definition of done:

- The production block explicitly covers cookie propagation, one intercept
  middleware scenario, and one loader middleware authorization scenario.
- Any intentionally dev-only subsection is called out with a brief reason.

### 1C. Finish Build Parity For Behavioral Parts Of `cache.test.ts`

Why:

- Cache behavior is part of the shipped runtime contract.
- Some remaining gaps are real product behavior gaps, not just debug-log gaps.

Tasks:

- Add build-mode coverage for:
  - intercept-cache behavior
  - `useLoader` registration behavior
  - proactive caching behavior, if stable in build mode
- Leave pure debug-log assertions as dev-only.

Definition of done:

- Production tests cover user-visible cache behavior.
- Log-format assertions stay isolated to dev mode and are described as such.

### 1D. Triage The Next Tier Of Dev-Only Specs

Why:

- Not every dev-only file deserves immediate build duplication.
- The backlog should distinguish true contract risk from lower-priority parity.

Candidates:

- `response-handler.test.ts`
- `revalidation.test.ts`
- `pending-actions.test.ts`
- `route-resolution.test.ts`
- `streaming-actions.test.ts`
- `handle-meta.test.ts`

Task:

- For each file, choose one outcome:
  - add build coverage now
  - explicitly defer
  - document as intentionally dev-focused

Definition of done:

- The production-parity backlog becomes smaller and more justified, not just
  differently worded.

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

### 2C. Make Dev-Only vs Build-Parity Intent Explicit

Tasks:

- Where a test section is intentionally dev-only, add a brief note in the test
  file or the backlog explaining why.
- Prefer this over leaving readers to infer intent from missing build blocks.

Definition of done:

- A contributor can tell which gaps are real, which are intentional, and where
  the current plan lives.

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
