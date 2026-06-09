> **Archived.** Remediation plan; all phases complete.

# Cache DSL + `"use cache"` Remediation Plan

Status: Implemented

This plan was executed as a series of phased commits. The sections below
document what was done in each phase for reference. All phases are complete.

Scope:

- `cache()` DSL behavior
- `"use cache"` transform/runtime behavior
- docs/API/spec alignment
- test coverage for high-risk cache correctness paths

## Phase 1: Remove global cache profile state leakage

Replaced process-global profile registry reads with router/request-scoped
resolution. DSL (`cache("profile")`) and runtime (`registerCachedFunction`)
resolve profiles from the active router context. Multiple router instances
with different `cacheProfiles` no longer interfere.

Key files: `cache-runtime.ts` (request-scoped resolution at line 78),
`profile-registry.ts` (DSL-time only at line 53).

## Phase 2: Enforce strict profile validation and directive parsing

Defined a single profile-name grammar (`^[a-zA-Z0-9_-]+$`), applied
consistently to config validation, transform-time parsing, and runtime
assertions. Unknown profile usage now fails with an explicit error instead
of silently degrading.

Key files: `profile-registry.ts` (validation at line 24),
`cache-runtime.ts` (unknown profile throw at line 83).

## Phase 3: Fix cache key correctness for tainted ctx + query variants

Included normalized user-facing search params in `"use cache"` key derivation
when tainted ctx is present. Internal params (`_rsc*`, `__*`) are excluded.

Key files: `cache-runtime.ts` (tainted key with search params at line 90).

## Phase 4: Make handle capture reentrant and concurrency-safe

Replaced monkey-patch capture with token/set-based capture API. Captures
are order-independent (no LIFO requirement), and concurrent requests do
not cross-capture handle data.

Key files: `handle-capture.ts` (token-based capture at line 16).

## Phase 5: Fix `cache()` orphan index stability

Allocated cache index once per `cache()` call path, reused for both item
name and namespace generation. No double increment in orphan path.

Key files: `dsl-helpers.ts` (single allocation at line 250).

## Phase 6: Align docs/specs with implemented semantics

Updated:

- `packages/rangojs-router/docs/use-cache-api-design.md`
- `docs/design/caching.md` (monorepo root)

Reconciled documented behavior with implementation. Profile grammar,
dev/prod differences, and DSL signatures are consistent across docs.

## Phase 7: Add targeted regression tests

Added regression coverage in `cache-remediation.test.ts` (line 8) for:

- Multi-router profile isolation
- Unknown profile failure mode
- Directive grammar edge cases
- Tainted ctx keying with query params
- Nested/concurrent handle capture
- Orphan `cache()` index determinism
