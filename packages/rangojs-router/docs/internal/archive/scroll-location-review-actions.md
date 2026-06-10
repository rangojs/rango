> **Archived.** Scroll/location-state review remediation plan; the fixes have landed.

# Scroll + Location State Review Actions (Non-Test Runtime)

Status: Implemented (polling cleanup in scroll-restoration.ts; sessionStorage
quota eviction in persistToSessionStorage)

Scope reviewed:

- `src/browser/scroll-restoration.ts`
- `src/browser/react/ScrollRestoration.tsx`
- `src/browser/react/location-state.ts`
- `src/browser/react/location-state-shared.ts`
- `src/browser/react/use-search-params.ts`
- `src/browser/navigation-transaction.ts`
- `src/browser/types.ts`

## Findings

### F1 (Medium): scroll restoration polling can outlive module lifecycle

Files:

- `src/browser/scroll-restoration.ts:147-153`
- `src/browser/scroll-restoration.ts:231-240`

`initScrollRestoration()` cleanup resets flags and listeners, but does not call `cancelScrollRestorationPolling()`. If polling is active (streaming restore path), the interval can continue after cleanup and still call `scrollTo`.

### F2 (Medium): plain useLocationState is not reactive for same-page programmatic updates

Files:

- `src/browser/react/location-state.ts:70-84`
- `src/browser/navigation-transaction.ts:338-342`

`useLocationState()` plain mode (no definition/key) reads `history.state.state`, but `__rsc_locationstate` handler only updates keyed typed states. Same-page `navigate(..., { state: <plain> })` updates history without popstate, so plain consumers can remain stale.

### F3 (Low): Readonly search params is type-only, mutable at runtime

Files:

- `src/browser/react/use-search-params.ts:44`
- `src/browser/types.ts:293-296`

Hook returns native `URLSearchParams` object directly, typed as read-only alias. Runtime mutators still exist and can mutate the stored URL object if called from JS/any-casts.

### F4 (Low): Scroll/info logs are not debug-gated

Files:

- `src/browser/scroll-restoration.ts:142-145,270,276,285,292,302,325`

Routine informational logs use `console.log` in hot paths.

## Commit Plan

### Commit 1: Cancel polling in scroll restoration cleanup

Files:

- `src/browser/scroll-restoration.ts`

Changes:

- Call `cancelScrollRestorationPolling()` in `initScrollRestoration()` cleanup.
- Optionally reset `customGetKey` on cleanup for cleaner teardown symmetry.

Tests:

- Add unit test ensuring active polling interval is cleared on cleanup.

### Commit 2: Make plain useLocationState reactive for locationstate events

Files:

- `src/browser/react/location-state.ts`
- (optional) `src/browser/navigation-transaction.ts`

Changes:

- In `handleLocationState`, when `key` is absent, update from `window.history.state?.state`.
- Keep typed-state behavior unchanged.

Tests:

- Add `use-location-state` test coverage for plain state update via `__rsc_locationstate` event.

### Commit 3: Runtime-readonly wrapper for useSearchParams (or explicit non-goal)

Files:

- `src/browser/react/use-search-params.ts`
- `src/browser/types.ts` (docs/comments)

Changes (pick one):

- Preferred: return a wrapper/proxy that throws on mutation methods.
- Alternative: document that readonly is compile-time only.

Tests:

- Add tests for mutation attempts (if wrapper approach chosen).

### Commit 4: Logging hygiene for scroll module

Files:

- `src/browser/scroll-restoration.ts`

Changes:

- Route info logs through debug gate (`debugLog`), keep warnings/errors explicit.

Tests:

- Optional; behavioral logging tests only if needed.

## Suggested Order

1. Commit 1 (lifecycle correctness)
2. Commit 2 (state reactivity correctness)
3. Commit 3 (API contract clarity)
4. Commit 4 (log hygiene)
