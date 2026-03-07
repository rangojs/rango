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

## Phase 1: Lock Down Semantics

Priority: highest

Canonical Phase 1 artifacts:

- [Execution model](./execution-model.md)
- [Semantic change checklist](./semantic-change-checklist.md)

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

## Phase 2: Expand Invariant Tests

Priority: highest

Build matrix-style tests around semantic boundaries, not just features.

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

## Phase 3: Add Runtime Guardrails

Priority: high

Add warnings and invariants where user intent is commonly misunderstood.

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

## Phase 4: Build Better Debugging

Priority: high

The router needs first-class observability because complexity is structural.

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
- [x] host routing boundaries (default cache key includes host)

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

## RFC Idea: Action Guards (Router-Level Only)

Status: draft RFC

Problem:

- Route middleware intentionally does not wrap action execution.
- Users need a first-class way to guard actions (authz, rate limits, policy checks)
  before action code runs.

Proposed API:

- `createRouter().guard(pathOrActionOrActions, middleware)`

Where `pathOrActionOrActions` is one of:

- `string` pattern (example: `"#/actions/shop/*"`)
- action function reference
- array of action function references

Examples:

```ts
const router = createRouter({ document: Document })
  .guard("#/actions/shop/*", requireAuth)
  .guard(addToCart, rateLimit)
  .guard([applyCoupon, checkout], requireAuth)
  .routes(urlpatterns);
```

Execution contract:

- Registration is allowed only at router level (not inside `urls()` definitions).
- Guards run in both JS and PE action flows.
- Guards execute before action invocation:
  `global middleware -> action guard(s) -> action -> route middleware (render/revalidation only)`.
- A guard may short-circuit by returning a `Response` (e.g. 401/redirect),
  which skips action execution and revalidation.

Matching contract:

- String patterns match the resolved server action id
  (`"src/path/to/actions.ts#exportName"` in RSC/server context).
- Function reference matching uses exact action function identity.
- Lazy `include()` and route tree composition do not affect guard registration
  or execution order.

Non-goal for this RFC:

- No `guard()` helper inside `urls()` route composition.

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
