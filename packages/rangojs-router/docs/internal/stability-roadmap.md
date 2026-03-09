# Stability Roadmap

This document turns the router's current design goals into a concrete stability
plan.

The router already has broad capability:

- named-route composition
- global and route middleware
- handlers, loaders, parallels, intercepts, and orphan layouts
- prerender, passthrough, and live request-time data
- client cache and partial revalidation
- response routes and non-HTML request handling

The main risk is no longer "missing features". The risk is complexity:

- subtle execution rules
- accidental security gaps
- JS vs PE drift
- cache/revalidation surprises
- difficult debugging when multiple features interact

The roadmap below prioritizes stability over surface-area growth.

## Goals

- Keep the router powerful without making behavior unpredictable.
- Make execution rules explicit, documented, and testable.
- Catch dangerous compositions early with warnings and invariants.
- Improve observability so complex behavior is debuggable in production.
- Keep security review aligned with new execution modes and transport paths.

## Non-Goals

- Reduce the router to a smaller but less capable model.
- Replace explicit APIs with hidden "smart" defaults.
- Flatten scope boundaries just to make behavior feel simpler.

## Guiding Principles

1. Correctness before convenience.
2. Explicit opt-in before implicit caching or revalidation.
3. One execution model, many capabilities.
4. Docs are part of the contract, not a follow-up task.
5. Debuggability is a stability feature.

## Core Contracts To Keep Sharp

These rules should stay consistent across code, tests, docs, and warnings:

- Global middleware wraps the entire request.
- Route middleware wraps rendering, not action execution.
- Route middleware still wraps PE full rerenders.
- Handler-first guarantees apply to full render passes.
- Partial action revalidation only recomputes opted-in segments.
- Parallel and orphan scopes are structural, not globally shared state.
- Loaders are live by default unless caching is explicitly configured.
- Prerendered handlers may be frozen while loaders remain live.
- Intercepts follow the same segment/revalidation rules as normal routes.

## Phase 1: Lock Down Semantics — Complete

Priority: highest | Status: **done**

Canonical Phase 1 artifacts:

- [Execution model](./execution-model.md)
- [Semantic change checklist](./semantic-change-checklist.md)
- This roadmap itself as the status anchor for later phases

Deliverables:

- Maintain a single contract document for:
  - middleware scopes
  - handler-first execution
  - parallel scope boundaries
  - PE vs JS parity
  - prerender vs passthrough vs live render
  - partial revalidation rules
  - producer/consumer revalidation contracts for shared `ctx.set()` dependencies
- Add explicit comments near implementation choke points:
  - RSC handler flow
  - progressive enhancement
  - action revalidation
  - route middleware execution
  - intercept resolution
- Treat stale docs as correctness bugs during review.

Success criteria:

- A reviewer can explain request flow from docs without reading the entire codebase.
- Tests and comments use the same terminology.

## Phase 2: Expand Invariant Tests — Complete

Priority: highest | Status: **done**

Build matrix-style tests around semantic boundaries, not just features.

Canonical Phase 2 artifacts:

- `e2e/semantic-matrix.test.ts`
- `docs/internal/test-quality-baseline.md`
- The completed A1-A7 test quality stabilization work tracked from that baseline

Required coverage:

- full render vs partial revalidation
- JS action vs PE form submission
- dev vs production build
- prerender vs passthrough vs live
- cache miss vs cache hit vs stale revalidation
- direct navigation vs soft navigation vs intercept navigation
- layout/orphan/parallel scope boundaries
- route middleware visibility before and after actions
- response routes and mixed request ownership

Recommended additions:

- "same scenario, different transport" pairs for JS and PE
- "same scenario, different navigation type" pairs for full and intercept flows
- negative tests that prove values do not cross scope boundaries
- targeted security tests around auth, redirects, cookies, and action exposure
- keep a small contract matrix suite (example:
  `e2e/semantic-matrix.test.ts`) that encodes core execution guarantees by axis
  instead of duplicating large one-off tests

Success criteria:

- Behavior changes fail fast in a small number of semantic tests.
- New features are added by extending a matrix, not inventing one-off tests.

## Phase 3: Add Runtime Guardrails — Partial

Priority: high | Status: **partial**

Add warnings and invariants where user intent is commonly misunderstood.

Canonical Phase 3 artifacts:

- [Runtime guardrails design](./runtime-guardrails-design.md)
- W1 shipped: route middleware used as if it guards actions
- W3 shipped: PE response/redirect guardrails
- W5 shipped: redirect after `ctx.set()` warning

Current status:

- W1, W3, and W5 are implemented.
- W2 was intentionally reframed as a docs/tests semantic contract rather than a
  runtime warning.
- W4 and W6 remain deferred because the signal-to-noise ratio is better served
  by Phase 4 observability than more speculative warnings.

Candidates:

- Route middleware used as if it guards actions.
- Child segments reading upstream context while outer segments do not revalidate.
- PE and JS code paths producing different response shapes for the same action.
- Conflicting cache and revalidation settings.
- Suspicious redirect/state combinations.
- Action requests that mutate cookies/headers but return flows that drop them.

Guideline:

- Warn when the router can identify likely misuse.
- Do not silently "fix" semantics by changing scope or execution order.

Success criteria:

- Common misconfigurations become visible during development before they ship.

## Phase 4: Build Better Debugging — Complete

Priority: high | Status: **done**

The router needs first-class observability because complexity is structural.

Canonical Phase 4 artifacts:

- [Telemetry guide](../telemetry.md)
- Request/revalidation trace support
- `onError` correctness audit and integration coverage
- Internal telemetry sink and OTel adapter/export

Recommended tooling:

- Request trace mode that shows:
  - matched route tree
  - rendered segments
  - skipped/revalidated segments
  - middleware execution order
  - loader execution and cache decisions
  - intercept resolution path
- Debug output for context propagation:
  - where a variable was set
  - which segment read it
  - whether the producing segment revalidated
- Better manifest/debug views for:
  - route ancestry
  - include scopes
  - parallel slots
  - intercept targets
  - prerender coverage

Success criteria:

- Complex request behavior can be explained from a debug trace without stepping through source.

## Phase 5: Security Hardening — Complete

Priority: high | Status: **done**

Security review has to track composition boundaries, not just endpoints.

Canonical Phase 5 artifacts:

- [Security checklist](./security-checklist.md) (updated with regression
  coverage from all Phase 5 slices)
- `e2e/auth-boundary.test.ts` — auth boundary correctness (PR #343)
- `e2e/content-ownership.test.ts` — content negotiation edges (PR #344)
- `e2e/cache-isolation.test.ts` — cache isolation (PR #345)
- Unit tests in `response-route-handler.test.ts` for condition() (PR #345)

Focus areas covered:

- [x] action authentication and authorization
- [x] global vs route middleware expectations
- [x] redirect validation (action redirect re-execution bug found and fixed)
- [x] cookie/header propagation
- [x] request-context isolation across async boundaries
- [x] PE form handling parity with JS action flow
- [x] cache leakage across users and query variants
- [x] response route ownership and escape hatches
- [x] content-negotiation and response/document pipeline edges
- [x] host cache isolation (default cache key includes host)

Bugs found and fixed:

1. **Action redirect re-execution** (PR #343): middleware redirects on action
   requests caused `fetch()` to follow the 302 and re-execute the action at the
   redirect target. Fixed by intercepting 3xx redirects for `_rsc_action`.
2. **Response cache condition() ignored** (PR #345): `condition()` callbacks
   were only checked in document/segment caching, not in the response route
   cache path. Fixed by adding condition evaluation to `response-route-handler.ts`.

Success criteria:

- New features cannot merge without reviewing auth, redirect, cookie, and cache implications.

## Phase 6: Keep The Public Model Smaller Than The Engine

Priority: medium

Internals can remain sophisticated. The user model must stay teachable.

Guidelines:

- Prefer a few precise primitives over many overlapping ones.
- Use docs to explain the execution model, not just API signatures.
- Keep advanced features composable but optional.
- Do not add convenience APIs that hide route tree structure.

Success criteria:

- A simple app can ignore most of the system.
- An advanced app can opt into power without breaking the mental model.

## Near-Term Checklist

- Keep the new middleware/PE/parallel scope contract synced across docs.
- Continue building semantic matrix tests like `mw-chain`.
- Keep producer/consumer partial revalidation rules explicit in docs and the
  semantic matrix; only add a runtime warning if a hidden stale-read case is
  concretely reproduced.
- Expand debug output for segment revalidation decisions.
- Write a reusable security checklist for actions, middleware, redirects, and cookies.

## Longer-Term Opportunities

- `import defer` integration for finer loading and startup optimization.
- richer route/debug visualizers
- stronger static analysis for revalidation and scope hazards
- host-aware cache and auth validation helpers

Future capabilities are welcome, but only if they preserve the same rule:

the router may grow in power, but its execution model should become more
explicit, not more mysterious.
