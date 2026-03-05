# Cache DSL + `"use cache"` Remediation Plan

Status: ready for implementation

Scope:

- `cache()` DSL behavior
- `"use cache"` transform/runtime behavior
- docs/API/spec alignment
- test coverage for high-risk cache correctness paths

Implementation model:

- You implement each phase as a separate commit.
- I review each commit before you continue to the next phase.
- Do not batch phases into one large commit.

## Phase 0: Baseline and branch hygiene

Goal:

- Start from a clean baseline and lock known behavior before semantic changes.

Actions:

1. Create a feature branch for this plan.
2. Run baseline tests:
   - `pnpm --filter @rangojs/router test:unit`
   - `pnpm --filter @rangojs/router test` (Playwright e2e)
3. Save baseline output in commit message notes or PR description.

Acceptance:

- Baseline passes, or failures are documented and unrelated.

Commit:

- `chore(cache): baseline before cache dsl/use-cache remediation`

## Phase 1: Remove global cache profile state leakage

Problem:

- Cache profiles are currently global mutable state and can bleed across routers/tests.

Actions:

1. Replace process-global profile registry reads with router/request-scoped resolution.
2. Ensure both DSL (`cache("profile")`) and runtime (`registerCachedFunction`) resolve profiles from the active router context.
3. Preserve default profile fallback behavior only inside the active router scope.

Acceptance:

- Multiple router instances with different `cacheProfiles` no longer interfere.
- No shared mutable profile map across routers in runtime-critical paths.

Commit:

- `refactor(cache): scope cache profiles per router context`

## Phase 2: Enforce strict profile validation and directive parsing

Problem:

- Unknown profiles can silently degrade to uncached execution.
- Directive regex is too restrictive/inconsistent for profile names.

Actions:

1. Define a single profile-name grammar (recommended: `^[a-zA-Z0-9_-]+$`).
2. Apply grammar consistently to:
   - config validation
   - transform-time parsing
   - runtime assertions
3. Convert unknown profile usage from silent bypass to explicit failure with actionable errors.
4. Keep errors deterministic in dev and build.

Acceptance:

- Unknown profile always fails with clear message.
- Valid profile names (including `-` and `_`) are accepted consistently.

Commit:

- `fix(use-cache): strict profile validation and directive grammar`

## Phase 3: Fix cache key correctness for tainted ctx + query variants

Problem:

- Tainted `ctx` key derivation can miss query/search dimensions, causing collisions.

Actions:

1. Include normalized user-facing search params in `"use cache"` key derivation when tainted ctx is present.
2. Exclude internal params (`_rsc*`, `__*`) to match existing route cache behavior.
3. Keep response-type separation where relevant (`ctx._responseType`).
4. Re-check key determinism (sorted params/search entries).

Acceptance:

- Query-variant requests generate distinct cache keys.
- Internal transport params do not split cache unnecessarily.

Commit:

- `fix(use-cache): include normalized search params in tainted ctx keys`

## Phase 4: Make handle capture reentrant and concurrency-safe

Problem:

- Current monkey-patching of `handleStore.push` is fragile for nested/concurrent cached calls.

Actions:

1. Replace monkey-patch capture with explicit capture API in `HandleStore` or a stack/token mechanism.
2. Guarantee nested captures restore correctly in LIFO order.
3. Ensure concurrent requests do not cross-capture handle data.

Acceptance:

- Nested cached function execution captures/restores without clobbering.
- No shared mutable capture hook that can leak across overlapping executions.

Commit:

- `refactor(cache): reentrant handle capture for use-cache`

## Phase 5: Fix `cache()` orphan index stability

Problem:

- Orphan `cache()` path increments index twice, creating unstable/id-gapped naming.

Actions:

1. Allocate cache index once per `cache()` call path.
2. Reuse it for both item name and namespace generation.
3. Keep existing external behavior unchanged except index consistency.

Acceptance:

- No double increment in orphan path.
- Route tree IDs remain deterministic across runs for same definitions.

Commit:

- `fix(cache-dsl): stabilize orphan cache index allocation`

## Phase 6: Align docs/specs with implemented semantics

Problem:

- Docs drift on profile validation, dev behavior, and API signatures.

Actions:

1. Update:
   - `packages/rangojs-router/docs/use-cache-api-design.md`
   - `docs/design/caching.md`
2. Reconcile documented behavior with implemented behavior after phases 1-5.
3. Ensure `cache("profile")` appears in canonical DSL signatures/examples if supported.
4. Explicitly document any intentional dev/prod behavior differences.

Acceptance:

- No contradictory statements across cache design docs.
- Docs match current implementation invariants.

Commit:

- `docs(cache): sync cache dsl/use-cache specs with implementation`

## Phase 7: Add targeted regression tests for fixed risks

Add tests for:

1. Multi-router profile isolation.
2. Unknown profile failure mode.
3. Directive grammar edge cases (`-`, `_`, invalid chars).
4. Tainted ctx keying with query params.
5. Nested/concurrent handle capture correctness.
6. Orphan `cache()` index determinism.

Suggested locations:

- unit: `src/cache/__tests__`, `src/__tests__`, `src/vite/__tests__`
- e2e: `e2e/use-cache.test.ts` additions

Acceptance:

- New tests fail on pre-fix behavior and pass with fixes.
- Existing cache/use-cache suites continue to pass.

Commit:

- `test(cache): add regression coverage for cache dsl/use-cache fixes`

## Review protocol (commit-by-commit)

For each phase commit:

1. Share commit hash.
2. Share exactly:
   - files changed
   - behavior delta
   - tests run
3. Wait for review before continuing.

Review gate checks:

- correctness
- API stability
- architecture consistency
- docs parity
- test quality and edge coverage
- performance/regression risk

## Final verification before merge

Run:

- `pnpm --filter @rangojs/router test:unit`
- `pnpm --filter @rangojs/router test`
- `pnpm --filter @rangojs/router typecheck`

Merge condition:

- all phases completed
- all review gates approved
- no unresolved docs/behavior drift
