---
name: render-cache-optimizer
description: Optimize a semantically correct Rango cached route with measured browser and MCP evidence. Use when warm documents or soft navigations still do unnecessary handler work, useful shell output is late, or loading flashes remain after cache adoption.
argument-hint: "[route]"
---

# Render Cache Optimizer

Start only after `/render-cache-adoption` proves freshness and authorization
semantics. Optimize one boundary at a time and retain a before/after measurement.

## Requires

Read `/rango`, `/render-cache-adoption`, `/observability`, and `/testing`. The
route must already have passing dev and production behavior tests.

## Preflight

Confirm clean compilation/discovery, warm the configured stores, and record the
same browser interaction and correlated MCP explanation at least twice.

## Scope Selection

Choose either initial document delivery or soft navigation. Name one target:
earlier useful shell, less handler work, an actual cache hit, lower server timing,
or removal of a loading flash without stale data.

## Diagnostic Loop

Capture browser timing/DOM plus handler, loader, cache, and PPR evidence. Change
one cache/PPR/loading boundary, repeat the same requests, and compare. Reject
noise-only changes and optimizations with no intended measured delta.

## Edit Rules

Preserve loader lanes, middleware, intercept selection, revalidation, and PE.
Do not widen shared artifacts around request/user identity. Do not tune TTL/SWR
to conceal a missing reusable artifact.

## Browser Verification

Compare cold and warm first paint, loading transitions, console/network output,
and visible freshness. Use browser timing for client-perceived improvements.

## Dev And Production Verification

Development proves the explanation delta; production proves the visible/timing
delta and unchanged behavior. Keep paired e2e cases and run bundle analysis when
plugin or client output changes.

## Bailout Conditions

Stop if the baseline is unstable, the route is not semantically correct, the
change freezes data, the intended tier never hits, or the measured delta is
within noise.

## Teardown

Remove profiling probes and temporary logs. Record the retained baseline and
delta in the test/PR evidence, not as permanent runtime instrumentation.

## Reference Links

- `/observability` for timing and telemetry.
- `/bundle-analysis` when output boundaries change.
- [Fixture task](./fixtures/task.md)
