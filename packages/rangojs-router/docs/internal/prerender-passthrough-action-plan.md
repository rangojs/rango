# Prerender Passthrough Action Plan

**Status: Superseded**

The original `{ passthrough: true }` option on `PrerenderOptions` has been
replaced by the `Passthrough(prerenderDef, liveHandler)` wrapper. See the
[prerender API design doc](../prerender-api-design.md) for current semantics.

## Summary of Change

- `Prerender(...)` is build-only by contract. All handlers are evicted in production.
- `Passthrough(prerenderDef, liveHandler)` wraps a Prerender definition with a
  separate live handler that runs at request time for unknown params.
- `ctx.passthrough()` remains available on `BuildContext` to skip individual
  param sets at build time (only valid on routes wrapped with `Passthrough()`).
- No `ctx.build` branching — build and runtime handlers are separate functions.
