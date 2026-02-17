# Review Actions & Outcomes

> Date: 2026-02-17
> Branch: `review/deep-code-fixes`
> Baseline: 1265 unit tests across 46 files
> Final: 1292 unit tests across 48 files (+27 tests, +2 new test files)

---

## Approach

1. **Test-first**: Every P0 bug had a failing test written before the fix.
2. **Unit tests where possible**: Pure functions and isolated logic got direct unit tests.
3. **Code-only fixes for browser runtime**: Browser-side bugs (P1-4/5/6) are covered by existing e2e tests; adding unit tests would require excessive mocking of DOM/navigation APIs.
4. **Parallel execution**: Multiple sub-agents worked on independent fixes simultaneously.

---

## P0 -- Critical (3/3 fixed, 3 tested)

### 1. Cached segment `loading` cleared from `false` to `undefined`
- **Fix**: `partial-update.ts` -- Changed condition to preserve `loading: false` (suppressed boundary) while still clearing truthy loading (active skeletons).
- **Test**: `partial-update.test.ts` -- Added "preserves loading=false for cached segment" test case.
- **Impact**: Prevents component remounts on navigations with suppressed-loading segments.

### 2. Cache deserialization `"null"` sentinel not handled
- **Fix**: `cache-scope.ts` -- Added check for `"null"` sentinel before calling `rscDeserialize()`. Sentinel is converted directly to `null` without touching the RSC decoder.
- **Test**: `cache/__tests__/cache-scope.test.ts` -- New test file (9 tests) covering serialization/deserialization round-trips and verifying the sentinel bypass.
- **Impact**: Cached segments with `loading: null` now survive cache round-trips correctly.

### 3. Prerender param hash collision
- **Fix**: `param-hash.ts` -- URL-encode keys and values before joining. Also switched `localeCompare` to byte-level comparison (fixes P1-10 simultaneously). Same fix applied to `cache-scope.ts:getCacheKeyBase()`.
- **Test**: `prerender/__tests__/param-hash.test.ts` -- New test file (20 tests) covering basic functionality, deterministic ordering, collision prevention, locale safety, and edge cases.
- **Impact**: Routes with special characters in param values no longer collide in prerender storage.

---

## P1 -- High (12/12 fixed, 7 tested)

### 4. Missing `.catch()` on tracking stream IIFE
- **Fix**: `navigation-client.ts` -- Added `.catch()` matching the pattern in `server-action-bridge.ts`.
- **Test**: Skipped -- browser stream mocking would be excessive; covered by e2e navigation tests.

### 5. `renderSegments` not awaited in popstate handler
- **Fix**: `navigation-bridge.ts` -- Added `await` to the `renderSegments()` call in the popstate cache-render path.
- **Test**: Skipped -- requires full browser navigation environment; covered by e2e back/forward tests.

### 6. `using tx` disposed before fire-and-forget fetch completes
- **Fix**: `navigation-bridge.ts` and `server-action-bridge.ts` -- Replaced `using tx` with manual `const tx` + `.finally(() => tx[Symbol.dispose]())` in both fire-and-forget paths.
- **Test**: Skipped -- async dispose timing is hard to unit test; the structural fix is clear.

### 7. Regex compiled per route per request
- **Fix**: `pattern-matching.ts` -- Added `Map<string, CompiledPattern>` cache with `getCompiledPattern()` wrapper.
- **Test**: `pattern-matching.test.ts` -- Added 4 tests verifying cache hit behavior and correctness.

### 8. `searchParams.set()` loses multi-valued params
- **Fix**: `handler-context.ts` -- Changed `.set()` to `.append()`.
- **Test**: `router/__tests__/handler-context.test.ts` -- New test file (6 tests) covering multi-valued params, system param stripping, and combined scenarios.

### 9. `prerenderTempServer` never closed in dev mode
- **Fix**: `vite/index.ts` -- Registered `server.httpServer?.on("close", ...)` cleanup callback.
- **Test**: Skipped -- requires full Vite dev server lifecycle; not practical to unit test.

### 10. `localeCompare` non-determinism in param hash
- **Fix**: Fixed simultaneously with P0-3 -- both `param-hash.ts` and `cache-scope.ts` now use byte-level comparison.
- **Test**: Covered by param-hash test suite (locale safety tests).

### 11. Circular loader dependencies deadlock
- **Fix**: `loader-resolution.ts` -- Added DFS-based cycle detection in both `setupLoaderAccess` and `setupLoaderAccessSilent`. Tracks dependency graph and pending loaders to detect cycles before deadlock.
- **Test**: `router/__tests__/loader-cycle-detection.test.ts` -- New test file (8 tests) covering direct cycles, three-way cycles, diamond deps, linear deps, memoization, and silent mode.

### 12. Empty `$$id` silently set to `""` in production
- **Fix**: `prerender.ts` -- Removed the dev-only conditional; now throws unconditionally in all environments.
- **Test**: Skipped -- the throw behavior is trivial; covered by any integration test that exercises prerender.

### 13. Progressive enhancement response drops cookies/headers
- **Fix**: `rsc/handler.ts` -- Changed both `new Response(...)` calls in `handleProgressiveEnhancement()` to `createResponseWithMergedHeaders(...)` (redirect path + HTML response path).
- **Test**: Skipped -- requires full RSC handler setup; better verified via e2e progressive enhancement tests.

### 14. Streaming token leaked on fetch failure
- **Fix**: `partial-update.ts` -- Wrapped `fetchPartial` in try/catch, calling `streamingToken.end()` in catch before re-throwing.
- **Test**: `partial-update.test.ts` -- Added "ends streaming token when fetchPartial throws" test.

### 15. `decodeURIComponent` in cookie parsing can crash request
- **Fix**: `request-context.ts` -- Wrapped `decodeURIComponent` in try/catch, falling back to raw value.
- **Test**: `server/__tests__/request-context.test.ts` -- Added 5 tests for normal parsing, percent-encoded values, malformed `%zz`, truncated `%2`, and coexistence scenarios.

---

## P2 -- Medium (10/21 fixed)

### Fixed:
| # | Issue | Fix | Test |
|---|-------|-----|------|
| 16 | JSONC URL corruption | State-machine `stripJsonComments()` replacing naive regex | No (build-time code) |
| 21 | Shared globalThis Map | Unnamed stores get isolated Map; named stores use registry | Yes (updated existing tests) |
| 25 | Watcher drops routes | `preserveIfLarger: true` on initial startup only (NOT watcher) | No (existing e2e covers) |
| 26 | Fragile loading condition | Explicit `!== null && !== undefined && !== false` | No (tree-structure e2e covers) |
| 29 | Dead code in partial-update | Removed unused `currentSegmentMap` reassignment | No (dead code removal) |
| 30 | useNavigation re-subscribe | Applied `selectorRef` pattern from use-action/use-handle | No (React hook) |
| 34 | Error subclass prototype | Added `Object.setPrototypeOf` to all 8 error classes | No (trivial pattern) |
| 35 | Scroll positions unbounded | Added MAX_SCROLL_ENTRIES=200 cap with LRU eviction + quota recovery | No (sessionStorage) |

### Skipped (not fixed):
| # | Reason |
|---|--------|
| 17 | `findClosingParen` string handling -- requires AST-level fix, risk of regression in Vite plugin transforms |
| 18 | Line-number-based inline handler hashes -- design decision, needs content-hash proposal |
| 19 | Triple AST parsing -- performance optimization, needs careful refactor of transform pipeline |
| 20 | Trie matching O(depth^2) -- performance micro-optimization, low real-world impact |
| 22 | `patternsByPrefix` propagation -- needs deeper context system understanding |
| 23 | handler.ts decomposition -- major refactor, out of scope for bug-fix pass |
| 24 | index.ts decomposition -- major refactor, out of scope for bug-fix pass |
| 27 | Dead code in route-content-wrapper -- harmless, low risk |
| 28 | Duplicated loader resolution -- needs coordinated refactor of segment-system + route-content-wrapper |
| 31 | useLocationState pushState -- needs custom event dispatch from navigation bridge |
| 32 | pushState not reverted -- needs error boundary integration for navigation failures |
| 33 | globalThis flag parallel builds -- edge case, needs per-build instance isolation |
| 36 | Non-atomic SWR in CF Workers -- acknowledged as accepted in design doc |

---

## P3 -- Low (4/10 fixed)

### Fixed:
| # | Issue | Fix |
|---|-------|-----|
| 38 | Double-await in cache-scope | Removed redundant `await component` |
| 42 | LRU has() side effect | Changed to use `this.cache.has()` directly |
| 44 | Loader HMR re-registration | Removed early-return guards, always update registry |
| 46 | Console debug log in production | Removed `console.log("payload.metadata", ...)` |

### Skipped (not fixed):
| # | Reason |
|---|--------|
| 37 | `expiresAt` redundancy -- harmless, store handles expiration |
| 39 | `debugStats` singleton -- only used in debug mode, low risk |
| 40 | `traverseBack` docstring -- documentation-only, trivial |
| 41 | Null promise caching -- needs cache invalidation strategy discussion |
| 43 | `MapRootLayout` naming -- trivial rename, not worth the churn |
| 45 | `handle-store` cloning -- needs profiling to confirm actual impact |

---

## Other Findings During Review

1. **cache-scope.ts also had `localeCompare`**: The `getCacheKeyBase()` function had the same non-deterministic sort as `param-hash.ts`. Fixed alongside P0-3/P1-10.

2. **P2-29 dead code was misleading**: The comment described a "BUG FIX" for intercept response handling, but the reassignment of `currentSegmentMap` occurred after the map was fully consumed. The "fix" never actually took effect.

3. **`using` keyword pattern conflict**: The `using` keyword with `Symbol.dispose` is fundamentally incompatible with fire-and-forget async patterns. Both navigation-bridge and server-action-bridge had this issue. The fix pattern (manual hold + `.finally()` dispose) should be the standard for all future fire-and-forget transactions.

4. **Pre-existing test infrastructure gap**: The e2e test-app was missing `@vitejs/plugin-react` as an installed dependency, causing `pnpm test` to fail on a clean checkout. Fixed during this review.

5. **`skipLoadingState` was never implemented in `getState()`**: The `createNavigationTransaction` accepted a `skipLoadingState` option (used by background SWR revalidation in popstate and server action bridge), but `event-controller.ts:getState()` never checked it. The state was always `"loading"` whenever `currentNavigation !== null`, even for background revalidations. This was exposed by the P1-5 fix (adding `await` to `renderSegments` in popstate), which changed async timing and caused `hooks.test.ts:385` to fail. Fixed by implementing `skipLoadingState` in `getState()` and `pendingUrl` derivation.

6. **P2-25 fix was too aggressive**: The initial P2-25 fix added `preserveIfLarger: true` to both the startup AND watcher paths. This broke route removal HMR (`route-types-hmr.test.ts:54`): the watcher saw "fewer routes" and skipped the write. The `preserveIfLarger` guard should only be on the initial startup path (to avoid overwriting runtime discovery output). The watcher must always reflect the current state so route additions AND removals work.

---

## Test Files Created/Modified

### New test files:
- `src/prerender/__tests__/param-hash.test.ts` (20 tests)
- `src/cache/__tests__/cache-scope.test.ts` (9 tests)
- `src/router/__tests__/handler-context.test.ts` (6 tests)
- `src/router/__tests__/loader-cycle-detection.test.ts` (8 tests)

### Modified test files:
- `src/__tests__/partial-update.test.ts` (+2 tests)
- `src/router/__tests__/pattern-matching.test.ts` (+4 tests)
- `src/server/__tests__/request-context.test.ts` (+5 tests)
- `src/cache/__tests__/memory-segment-store.test.ts` (updated for isolation)

---

## Source Files Modified

| File | Changes |
|------|---------|
| `src/prerender/param-hash.ts` | URL-encode + byte-level sort |
| `src/cache/cache-scope.ts` | Null sentinel handling + byte-level sort + double-await |
| `src/browser/partial-update.ts` | Preserve loading=false + streaming token safety + dead code removal + debug log removal |
| `src/browser/navigation-client.ts` | Added .catch() on tracking stream |
| `src/browser/navigation-bridge.ts` | await renderSegments + manual tx lifecycle |
| `src/browser/server-action-bridge.ts` | Manual tx lifecycle |
| `src/router/pattern-matching.ts` | Compiled pattern cache |
| `src/router/handler-context.ts` | .set() -> .append() |
| `src/router/loader-resolution.ts` | Cycle detection |
| `src/server/request-context.ts` | Safe decodeURIComponent |
| `src/rsc/handler.ts` | createResponseWithMergedHeaders for PE |
| `src/prerender.ts` | Unconditional throw for missing $$id |
| `src/vite/index.ts` | stripJsonComments + preserveIfLarger + prerenderTempServer cleanup |
| `src/segment-system.tsx` | Explicit loading condition |
| `src/errors.ts` | Object.setPrototypeOf in all error classes |
| `src/browser/scroll-restoration.ts` | Bounded scroll positions with eviction |
| `src/browser/react/use-navigation.ts` | selectorRef pattern |
| `src/browser/lru-cache.ts` | has() without promotion |
| `src/server/loader-registry.ts` | Allow HMR re-registration |
| `src/cache/memory-segment-store.ts` | Per-instance isolation |
| `src/browser/event-controller.ts` | Implement skipLoadingState in getState() and pendingUrl |
