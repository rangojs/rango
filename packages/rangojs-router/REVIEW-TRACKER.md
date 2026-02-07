# @rangojs/router - PR Review Tracker

PR #127 review findings. Work through items top-to-bottom, check off as completed.

---

## 1. Unit Test Coverage (17% -> target: 50%+)

### P0 - Critical (would catch real bugs)

- [x] **`segment-system.tsx`** (442 lines, 33 tests) ✅
  - Tree structure consistency between SSR, navigation, and action render paths
  - LoaderBoundary vs RouteContentWrapper wrapping decision
  - Suspense key generation (outletKey vs useId)
  - Lazy component promise handling
  - _Why critical: documented as the most fragile area; tree mismatches destroy useActionState, refs, local state_
  - Tests: `src/__tests__/segment-system.test.tsx` (33 tests, all pass)

- [x] **`navigation-store.ts`** (823 lines, 45 tests) ✅
  - LRU history cache: eviction at 20 entries, stale detection, SWR pattern
  - Cross-tab BroadcastChannel: invalidation, segment overlap detection, idle queueing
  - Action state: subscribe/unsubscribe, empty set cleanup
  - Debounced notifier: coalesces rapid state changes
  - _Why critical: all client state flows through this; cache bugs = stale UI_
  - Tests: `src/__tests__/navigation-store.test.ts` (45 tests, zero mocks, all pass)

- [x] **`partial-update.ts`** (600 lines, 20 tests) ✅
  - Segment diff/merge algorithm (matched vs diff arrays)
  - The `.@` intercept filter (line 162 - has `TODO: why this?`)
  - Full update fallback when segment structure changes
  - Stale navigation detection (signal.aborted check)
  - _Why critical: incorrect merging = wrong components rendered after navigation_
  - Tests: `src/__tests__/partial-update.test.ts` (20 tests, all pass)

### P1 - High Value

- [ ] **`server-action-bridge.ts`** (762 lines, 0 tests)
  - Action execution and response handling
  - Error boundary response processing
  - Segment revalidation after action
  - Concurrent action limiting
  - `using` handle cleanup on error paths
  - _Note: heavily coupled to browser globals (window, fetch, history.state); hard to unit test without extensive mocking_

- [x] **`router.ts` helpers** (pattern-matching, middleware, href) - 55 tests ✅
  - `compilePattern()` - route pattern compilation with params, optionals, constraints, wildcards
  - `extractStaticPrefix()` - prefix extraction for O(1) short-circuit
  - `findMatch()` - core route matching with lazy detection, trailing slash modes
  - `parsePattern()` (middleware) - middleware pattern parsing
  - `extractParams()` - param extraction from regex matches
  - `parseCookies()` / `serializeCookie()` - cookie handling utilities
  - `createHref()` - URL generation with param substitution
  - Tests: `src/__tests__/router-helpers.test.ts` (55 tests, all pass)

- [x] **`event-controller.ts`** (876 lines, 54 tests) ✅
  - Action lifecycle (start -> streaming -> complete/error -> settle)
  - Navigation switchMap semantics (new cancels previous)
  - Concurrent action tracking and consolidation
  - Symbol.dispose cleanup for both navigation and actions
  - Debounced notifications (subscribe, subscribeToAction, subscribeToHandles)
  - Handle data operations (full/partial update, filterSegmentOrder)
  - Tests: `src/__tests__/event-controller.test.ts` (54 tests, fake timers, all pass)

### P2 - Good to Have

- [ ] **`rsc/handler.ts`** (1,079 lines, 0 tests)
  - Document vs partial rendering paths
  - Server action decoding and execution
  - Loader resolution during rendering

- [ ] **`errors.ts`** (259 lines, 0 tests)
  - `isNetworkError()` with TypeError, DOMException, NetworkError
  - `sanitizeError()` dev vs prod behavior
  - `invariant()` assertion

- [ ] **`href.ts`** (255 lines, 0 tests)
  - Parameter substitution edge cases
  - Missing/extra params handling
  - Trailing slash application

- [ ] **React hooks** (0 tests each)
  - `use-action.ts` (240 lines) - action state subscription
  - `use-navigation.ts` (140 lines) - navigation state access
  - `use-handle.ts` (209 lines) - handle data collection
  - `use-segments.ts` (188 lines) - segment tree access

- [ ] **`NavigationProvider.tsx`** (346 lines, 0 tests)
  - Context initialization
  - Warmup effect
  - Connection warmup lifecycle

- [ ] **`server/context.ts`** (460 lines, 0 tests)
  - AsyncLocalStorage context propagation
  - `runWithStore` / `runWithPrefixes`
  - TrackedInclude management

---

## 2. Code Quality Issues

### Must Fix

- [ ] **Strip/guard 100+ `console.log` in browser code**
  - None are behind `import.meta.env.DEV` or a debug flag
  - Worst offenders: `server-action-bridge.ts` (40+), `partial-update.ts` (25+), `navigation-bridge.ts` (20+)
  - Options: (a) wrap in `if (import.meta.env.DEV)`, (b) create debug() util that tree-shakes in prod, (c) remove entirely

- [ ] **Resolve `TODO: why this?` in `partial-update.ts:162`**
  - `segments = currentSegments.filter((id) => !id.includes(".@"));`
  - Filters parallel route segments when leaving intercept
  - Either document the reason or add a test proving correctness

### Should Fix

- [ ] **Extract `(env as any)?.Bindings ?? env` pattern** (`router.ts:3656, 3843`)
  - Two identical unsafe casts for Cloudflare bindings extraction
  - Should be a shared `extractBindings(env)` utility

- [ ] **`getNonceAttribute` doesn't escape nonce** (`theme-script.ts:150-152`)
  - `return nonce ? \` nonce="${nonce}"\` : "";`
  - Low risk (nonces are base64), but should escape `"` for defense in depth

---

## 3. DX Improvements

### High Priority

- [ ] **Client `createLoader` naming confusion**
  - Server version (real loader) vs client version (no-op stub) share same name
  - Consider renaming client version or adding clear JSDoc warning

- [ ] **`RouteNotFoundError` should suggest closest match**
  - Currently just says "no route matches"
  - In large apps, showing available routes or closest match helps debugging

- [ ] **Missing catch-all route pattern**
  - No built-in `path("/*", NotFound)` equivalent
  - Users must handle 404s via error boundaries or middleware

### Medium Priority

- [ ] **Three href patterns are confusing**
  - `href("route", params)` vs `router.href("route", params)` vs `scopedHref()`
  - Document when to use which

- [ ] **`Link` uses `to` prop instead of `href`**
  - Breaks conventions from Next.js / React Router
  - Consider supporting both or switching to `href`

- [ ] **Handle `collect` function underdocumented**
  - Custom collect patterns lack examples

---

## 4. Known Issues (Pre-existing)

- [ ] **6 E2E test failures in cache/intercept tests** (as of 2026-02-05)
  - Track as issues or document as known limitations
  - Tests: cache.test.ts, intercept-related assertions

- [ ] **HMR strategy undocumented**
  - No custom HMR event handlers in Vite plugin
  - May rely entirely on `@vitejs/plugin-rsc`
  - Verify and document the assumption

---

## 5. Architecture Notes (No Action Needed)

These were reviewed and found to be sound:

- `router.ts` at 4,523 lines is large but justified (single factory, delegates well)
- No circular dependencies detected
- Type system is strong (minimal `as any`, good inference)
- Error handling is production-grade (cause chains, env-aware sanitization)
- Security is solid (no XSS, no injection vectors, safe `dangerouslySetInnerHTML`)
- Client state management has proper cleanup (listeners, `using` dispose, debouncing)
- Cache invalidation is sound (TTL + manual + cross-tab)
- Cross-tab BroadcastChannel sync handles races correctly

---

## Progress Log

| Date | Item | Status |
|------|------|--------|
| 2026-02-06 | Initial review completed | Done |
| 2026-02-06 | `segment-system.tsx` - 33 unit tests | Done |
| 2026-02-06 | `navigation-store.ts` - 45 unit tests (zero mocks) | Done |
| 2026-02-06 | `partial-update.ts` - 20 unit tests | Done |
| 2026-02-06 | `event-controller.ts` - 54 unit tests (P1) | Done |
| 2026-02-06 | `router.ts` helpers - 55 unit tests (P1) | Done |
| | | |
