# Routes Lazy Evaluation Analysis

## Summary

The failure is caused by JavaScript module evaluation order in circular imports, not by missing manifest data.

When `router.tsx` imports `urlpatterns` and a page imported by `urls.tsx` imports `reverse` from `router.tsx`, module evaluation can re-enter `router.tsx` before `urlpatterns` is initialized. In that window, `.routes(urlpatterns)` receives `undefined`.

## What Breaks Exactly

Observed invariant:

`createRouteBuilder received null/undefined routes for prefix ""`

Sequence:

1. `router.tsx` starts evaluating and imports `urlpatterns`.
2. `urls.tsx` starts evaluating and imports page modules.
3. A page module imports `reverse` from `router.tsx`.
4. `router.tsx` is re-entered before `urlpatterns` is fully initialized.
5. `.routes(urlpatterns)` gets an unresolved value and fails.

This is independent of route manifest generation. Manifest/plugin data is build-time/runtime metadata; this crash happens earlier during module initialization.

## Why Internal Laziness Is Not Enough

`routes(urlpatterns)` cannot be made equivalent to `routes(() => urlpatterns)` only from inside `routes(...)`.

Reason:

1. Function arguments are evaluated before the function runs.
2. With `.routes(urlpatterns)`, the router receives a value snapshot.
3. Wrapping that snapshot internally in a callback does not recover the live binding.

Only a callback created at the call site can read `urlpatterns` later:

- `routes(urlpatterns)` -> eager value
- `routes(() => urlpatterns)` -> lazy binding read

## Design Options

### Option A: Explicit lazy callback in userland

Examples:

- `.routes(() => urlpatterns)`
- `createRouter({ urls: () => urlpatterns })`

Pros:

- Minimal conceptual change.
- Solves circular import timing.
- No hidden compile transform required.

Cons:

- New syntax for cyclic setups.
- Tooling/parsers must recognize callback form.

### Option B: Keep user syntax, rewrite in Vite plugin

Transform:

- `.routes(urlpatterns)` -> `.routes(() => urlpatterns)`

Pros:

- No user-facing API change.
- Keeps old code style.

Cons:

- Adds transform complexity and maintenance.
- Must be precise across chained calls and TS syntax forms.
- Non-Vite environments need equivalent transform for parity.

### Option C: Split reverse exports into cycle-safe module

Move route reversing access away from `router.tsx` so pages do not import router module directly.

Pros:

- Reduces circular-import pressure structurally.

Cons:

- Larger API/DX change.
- Migration burden across apps.

## Recommended Direction

If the goal is low-risk and explicit behavior, use Option A as the baseline:

- Keep `.routes(urlpatterns)` for normal eager cases.
- Document `.routes(() => urlpatterns)` for cyclic imports.
- Keep route-type extraction support for callback form.

If preserving existing app syntax is mandatory, add Option B as a targeted plugin transform and keep Option A as fallback semantics.

## Notes For Current Work

- This issue is not caused by SSR manifest readiness.
- It is a runtime module-evaluation ordering issue surfaced during HMR/full reload paths.
- Any solution that does not preserve a live binding read at call site cannot solve this class of cycle.
