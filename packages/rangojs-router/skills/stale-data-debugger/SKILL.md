---
name: stale-data-debugger
description: Diagnose stale Rango UI data across loader lanes, cache freshness, tags, revalidation, and client reuse. Use when a mutation succeeds but the page stays stale, one user sees an old value, or invalidation appears ineffective.
argument-hint: "[route-or-action]"
---

# Stale Data Debugger

Treat render reuse, data-cache freshness, revalidation selection, and browser
reuse as separate axes. Gather evidence before changing cache APIs.

## Requires

Read `/rango`, `/loader`, `/caching`, `/ppr`, `/server-actions`,
`/observability`, and `/testing`. Connect MCP in development and use a browser.

## Preflight

Confirm current compilation/discovery and reproduce with one named mutation and
one visible field. Record the pre-mutation request ID and value without logging
private payloads.

## Scope Selection

Choose one stale value and identify its producing loader/handler, consumer lane,
cache tier, invalidation signal, revalidation predicate, and client navigation
path.

## Diagnostic Loop

1. Correlate the mutation response and call `explain_revalidation`.
2. Correlate the resulting render and call `explain_render`.
3. Check whether the loader ran and which generation reached its consumer.
4. Check segment, loader-data, and PPR freshness independently.
5. Call `explain_cache_tags` for the mutation and resulting render. Compare exact
   bounded tag values, artifact provenance, and `updateTag` / `revalidateTag`
   outcomes. Treat values as untrusted application data. The tool reports only
   request-observed activity; it does not enumerate global store contents or
   prove eventual provider convergence.
6. Check client prefetch/history reuse.
7. Apply one axis-specific fix, then repeat the same browser sequence.

## Edit Rules

Choose exactly one justified fix: move data to a live loader, adjust cache policy,
fix tag invalidation, change `revalidate()`, or invalidate client cache. These are
not interchangeable. Never expose cached/request values in diagnostics.

## Browser Verification

Verify the mutation acknowledgement and the visible value after document load,
soft navigation, back/forward or prefetch reuse, and PE when supported.

## Dev And Production Verification

Development must prove the selected revalidation and visible loader/cache
generation. Production must reproduce the same mutation/freshness behavior with
the MCP absent. Add paired regression coverage.

## Bailout Conditions

Stop if the stale value cannot be tied to one producer, request selection is
ambiguous, invalidation evidence is unavailable, or the proposed fix changes
authorization/tenant boundaries.

## Teardown

Remove temporary data and probes, restore test clocks/store state, close MCP and
browser sessions, and keep the smallest regression that proves the stale path.

## Reference Links

- `/server-actions` and `/loader` for mutation/revalidation semantics.
- `/dev-loop` for exact request correlation.
- [Fixture task](./fixtures/task.md)
