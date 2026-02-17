# Deep Code Review: @rangojs/router

> Generated: 2026-02-17
> Scope: Full codebase deep review (Vite plugin, segment system, router matching, caching/prerender, server/RSC handler, browser runtime, tests & CI)
> **Status: WORK IN PROGRESS** -- See REVIEW-DONE.md for detailed action log.

## Policy

**All bugs must have a failing test (unit or e2e) reproducing the issue before any fix is applied.** No fix without reproduction.

---

## Progress Summary

| Severity | Total | Fixed | Tests Added | Skipped |
|----------|-------|-------|-------------|---------|
| P0       | 3     | 3     | 3 (unit)    | 0       |
| P1       | 12    | 12    | 7 (unit)    | 0       |
| P2       | 21    | 10    | 2 (unit)    | 11      |
| P3       | 10    | 4     | 0           | 6       |

---

## Severity Guide

| Level | Meaning |
|-------|---------|
| **P0** | Tree-structure corruption, data loss, or silent wrong behavior in production |
| **P1** | Crash, resource leak, or significant correctness issue under realistic conditions |
| **P2** | Performance issue, code quality risk, or correctness bug in edge cases |
| **P3** | Minor cleanup, documentation, or low-probability concern |

---

## P0 -- Critical

### 1. Cached segment `loading` cleared from `false` to `undefined` (tree structure change) -- FIXED, TESTED

- **File:** `src/browser/partial-update.ts:359-361`
- **What:** When a segment is pulled from cache during navigation (server decided not to re-render it), its `loading` is unconditionally set to `undefined`. If the cached segment had `loading: false` (suppressed), this changes the React tree from `LoaderBoundary > OutletProvider` to just `OutletProvider`, causing component remounts and client state loss.
- **Impact:** Client state destroyed on navigations where suppressed-loading segments are reused from cache.
- **Contrast:** `server-action-bridge.ts:439-445` correctly preserves cached loading values.
- **Repro:** Navigate from a route with `loading: false` segment, then navigate to a route that shares that segment. Observe component remount.

### 2. Cache deserialization passes `"null"` string to `rscDeserialize` instead of restoring `null` -- FIXED, TESTED

- **File:** `src/cache/cache-scope.ts:255`
- **What:** During serialization, `loading: null` is stored as `"null"` sentinel string. During deserialization, this sentinel is passed directly to `rscDeserialize()` instead of being converted back to `null`. The deserialized segment gets `loading: "null"` (a truthy string), changing the tree structure category from "none" to "active".
- **Impact:** Cached segments with explicit `loading: null` get wrong tree structure after cache round-trip.
- **Repro:** Cache a route with `loading: null`, evict from memory, read back from store. Inspect the segment's `loading` value.

### 3. Prerender param hash collision for values containing `=` or `&` -- FIXED, TESTED

- **File:** `src/prerender/param-hash.ts:20-21`
- **What:** Hash input is `key=value` joined by `&` without encoding. `{ a: "1&b=2" }` and `{ a: "1", b: "2" }` produce identical hash input `"a=1&b=2"`, mapping to the same prerender cache key. One variant's data overwrites the other.
- **Impact:** Wrong prerender content served in production for routes with special characters in param values.
- **Fix:** URL-encode keys and values, or use a separator that cannot appear in values (e.g., `\0`).

---

## P1 -- High

### 4. Missing `.catch()` on tracking stream IIFE -- FIXED

- **File:** `src/browser/navigation-client.ts:134-154`
- **What:** The tracking stream reader IIFE has no `.catch()` handler. On network disconnect, `reader.read()` throws an unhandled promise rejection. Compare with `server-action-bridge.ts:210` which has `.catch()`.
- **Fix:** Add `.catch()` matching the pattern in `server-action-bridge.ts`.

### 5. `renderSegments` not awaited in popstate handler -- FIXED

- **File:** `src/browser/navigation-bridge.ts:754`
- **What:** `renderSegments()` is async and returns `Promise<ReactNode>`. In the popstate handler it is called without `await`, passing a Promise object as `root` to `onUpdate` instead of a ReactNode. Every other call site awaits.
- **Impact:** React receives a Promise instead of renderable content during back/forward navigation.

### 6. `using tx` disposed before fire-and-forget fetch completes -- FIXED

- **File:** `src/browser/navigation-bridge.ts:778-817`
- **Also:** `src/browser/server-action-bridge.ts:512-532`
- **What:** `using tx` creates a navigation transaction inside a block scope. `fetchPartialUpdate` is called without `await` (fire-and-forget). The `tx` is disposed when the block exits (immediately), before the fetch completes. Dispose resets navigation state to idle prematurely.
- **Fix:** Don't use `using` for fire-and-forget patterns. Hold the transaction manually and clean up in the promise chain.

### 7. Regex compiled per route per request in fallback path -- FIXED, TESTED

- **File:** `src/router/pattern-matching.ts:337`
- **What:** `findMatch` calls `compilePattern()` for every route on every request in the non-trie fallback path. Each call allocates a RegExp and ParsedSegment arrays.
- **Impact:** O(routes) regex compilations per request. Significant for large route tables.
- **Fix:** Cache compiled patterns in a `Map<string, CompiledPattern>`.

### 8. `searchParams.set()` loses multi-valued query params -- FIXED, TESTED

- **File:** `src/router/handler-context.ts:85`
- **What:** `cleanSearchParams.set(key, value)` keeps only the last value per key. `?tag=a&tag=b` becomes `?tag=b`.
- **Fix:** Use `.append()` instead of `.set()`.

### 9. `prerenderTempServer` never closed in dev mode -- FIXED

- **File:** `src/vite/index.ts` (prerenderTempServer creation)
- **What:** The temporary server created for prerender in dev mode has no cleanup hook on dev server shutdown. The server and its resources leak.
- **Fix:** Register a cleanup callback on Vite's dev server close event.

### 10. `localeCompare` non-determinism in param hash -- FIXED (with P0-3)

- **File:** `src/prerender/param-hash.ts:20`
- **What:** `localeCompare` behavior varies across JS runtimes with different ICU data. Build-time (Node) and runtime (CF Workers) could produce different sort orders for non-ASCII param names, causing hash mismatches.
- **Fix:** Use byte-level comparison (`a < b ? -1 : a > b ? 1 : 0`).

### 11. Circular loader dependencies deadlock -- FIXED, TESTED

- **File:** `src/router/loader-resolution.ts:210-214`
- **What:** Loaders can call `ctx.use(otherLoader)`. If A depends on B and B depends on A, memoization prevents infinite recursion but creates a deadlock: both promises wait on each other forever. No cycle detection.
- **Fix:** Track the current resolution chain and throw on cycle detection.

### 12. Empty `$$id` silently set to `""` in production -- FIXED (throws unconditionally)

- **File:** `src/prerender.ts:125-133`
- **What:** Missing `$$id` throws in dev but silently becomes `""` in production. All handlers without IDs share the empty-string key, causing incorrect prerender store lookups.
- **Fix:** At minimum, log a warning in production. Consider a fallback ID.

### 13. Progressive enhancement response drops cookies/headers -- FIXED

- **File:** `src/rsc/handler.ts:940`
- **What:** The progressive enhancement handler returns `new Response(...)` directly instead of `createResponseWithMergedHeaders(...)`. Cookies set via `ctx.setCookie()` and middleware response headers are silently dropped. Every other response path uses `createResponseWithMergedHeaders`.

### 14. Streaming token leaked on fetch failure -- FIXED, TESTED

- **File:** `src/browser/partial-update.ts:196-205`
- **What:** `tx.startStreaming()` is called before `await client.fetchPartial(...)`. If the fetch throws, `streamingToken.end()` is never called. `activeStreamCount` in the event controller stays incremented forever, causing `isStreaming` to be permanently `true`.
- **Fix:** Wrap in try/catch and call `streamingToken.end()` in the catch block.

### 15. `decodeURIComponent` in cookie parsing can crash request -- FIXED, TESTED

- **File:** `src/server/request-context.ts:421`
- **What:** Malformed percent-encoded cookie values (e.g., `%zz`) cause `decodeURIComponent` to throw `URIError`, crashing the entire request.
- **Fix:** Wrap in try/catch, fall back to raw value.

---

## P2 -- Medium

### 16. JSONC comment stripping corrupts URLs containing `//` -- FIXED

- **File:** `src/vite/index.ts:1621`
- **What:** Regex `raw.replace(/\/\/.*$/gm, "")` strips `//` inside JSON string values (e.g., `"url": "https://example.com"`).

### 17. `findClosingParen` doesn't handle parens in strings

- **File:** `src/vite/expose-id-utils.ts:283-292`
- **What:** The simple paren matching doesn't skip string contents. `createLoader(() => fetch("api?q=(test)"))` would miscount.

### 18. Inline handler hashes are line-number-based (unstable)

- **File:** `src/vite/ast-handler-extract.ts:308`
- **What:** `hashInlineId(filePath, site.lineNumber, lineCount)` means reformatting (e.g., Prettier) changes all inline handler IDs.

### 19. Triple AST parsing in `transformInlineHandlers`

- **File:** `src/vite/ast-handler-extract.ts:336`
- **What:** Same code is parsed 3 times: `findHandlerCalls`, `extractImportDeclarations`, and `findImportInsertionPos`. The AST from the first parse should be reused.

### 20. Trie matching O(depth^2) array allocations

- **File:** `src/router/trie-matching.ts:103-105`
- **What:** `[...paramValues, segment]` creates a new array per param match level. A mutable push/pop approach would eliminate the quadratic allocation.

### 21. All `MemorySegmentCacheStore` instances share same `globalThis` Map -- FIXED, TESTED

- **File:** `src/cache/memory-segment-store.ts:80-84`
- **What:** Defeats per-section store isolation. Two stores with different defaults share the same backing Map.

### 22. `patternsByPrefix` not propagated in `run()`/`runWithStore()`

- **File:** `src/server/context.ts:341-392`
- **What:** Nested contexts created by `run()` and `runWithStore()` lose the `patternsByPrefix` map from the parent store.

### 23. `rsc/handler.ts` is ~1500 lines mixing 5+ concerns

- **File:** `src/rsc/handler.ts`
- **What:** Mixes response route handling, progressive enhancement, server action execution, loader fetch, and RSC rendering. Should be decomposed into separate modules.
- **Also:** `isRscRequest` duplicated at lines 763 and 1422. URL param cleaning duplicated 3 times. RscPayload construction duplicated ~8 times.

### 24. `createRouterDiscoveryPlugin` is 1130+ lines with 17 state variables

- **File:** `src/vite/index.ts`
- **What:** Cognitive load too high. Prerender logic, manifest generation, and dev middleware should be extracted.

### 25. Dev watcher can overwrite runtime route maps with partial static maps -- FIXED

- **File:** `src/vite/index.ts:964, 1186`
- **What:** Startup writes with `preserveIfLarger: true`, but watcher writes without it. Watcher can shrink `router.named-routes.gen.ts`, dropping routes.
- **Fix:** Use same `preserveIfLarger: true` guard in watcher path.

### 26. `segment-system.tsx:213` fragile condition for falsy ReactNode -- FIXED

- **What:** `loading !== null && loading` would treat `0` (valid React content) as falsy, skipping `RouteContentWrapper`. The two conditions on lines 213 and 245 encode the three-way split implicitly.

### 27. Dead code in `route-content-wrapper.tsx:29-32`

- **What:** `!content` can never be true since `content` is always wrapped in `Promise.resolve()` by the caller.

### 28. Duplicated loader resolution logic

- **What:** `resolveLoaderData()` in `segment-system.tsx` and `LoaderResolver` in `route-content-wrapper.tsx` duplicate the same unwrapping logic. If the format changes, both must be updated.

### 29. Dead code in `partial-update.ts:466-471` -- FIXED

- **What:** `currentSegmentMap` is reassigned after it was already consumed by the segment merge loop. The reassigned value is never used.

### 30. `useNavigation` selector dep causes effect re-run every render -- FIXED

- **File:** `src/browser/react/use-navigation.ts:128`
- **What:** If caller passes inline selector (common: `useNavigation(nav => nav.state)`), the dependency array triggers unsubscribe + resubscribe on every render. `use-action.ts` and `use-handle.ts` correctly use `selectorRef` pattern.

### 31. `useLocationState` does not update on `pushState`/`replaceState`

- **File:** `src/browser/react/location-state.ts:49-58`
- **What:** Hook only listens to `popstate` events. Programmatic `pushState`/`replaceState` calls don't fire `popstate`, so the hook shows stale data until back/forward navigation.

### 32. Early `pushState` not reverted on navigation failure

- **File:** `src/browser/navigation-bridge.ts:209-211`
- **What:** `pushState` happens before the navigation completes. If navigation fails (network error), the URL has already changed. Error handling does not revert the history push.

### 33. `globalThis` flag not safe for parallel builds

- **File:** `src/vite/index.ts` (`__rscRouterDiscoveryActive`)
- **What:** Module-level boolean flag on globalThis. Concurrent Vite builds in the same process would interfere.

### 34. Missing `Object.setPrototypeOf` in Error subclasses -- FIXED

- **File:** `src/errors.ts`
- **What:** Custom error classes don't set prototype correctly. `instanceof` fails after transpilation. Already worked around at `handler.ts:710-711` with a dual check, but not in other locations.

### 35. Unbounded `savedScrollPositions` growth -- FIXED

- **File:** `src/browser/scroll-restoration.ts:30`
- **What:** Accumulates entries for every unique scroll key, never evicts. Can exceed `sessionStorage` 5MB limit.

### 36. Non-atomic SWR marking in CF Workers multi-isolate

- **File:** `src/cache/cf/cf-cache-store.ts:259-272`
- **What:** "Atomically mark REVALIDATING" is per-isolate only. Two isolates can both see stale and both trigger revalidation. Acknowledged in design doc as accepted.

---

## P3 -- Low

### 37. `expiresAt` redundancy in `CachedEntryData`

Set by caller, then overwritten by store. Field is unused for actual expiration checks.

### 38. Double-await on component in `cache-scope.ts:253` -- FIXED

`createFromReadableStream` returns Promise; first `await` resolves it, second `await component` is a no-op.

### 39. `debugStats` is a mutable module-level singleton

`pattern-matching.ts:256-257` -- shared across concurrent requests. Would need per-request scope for safe concurrent debugging.

### 40. `traverseBack` docstring says child-to-parent, code yields root-to-child

`pattern-matching.ts:414-425` -- misleading JSDoc.

### 41. Permanently cached null promises in prerender store

`prerender/store.ts:65-78` -- if `loader()` rejects, the `.catch(() => null)` promise is cached permanently.

### 42. `has()` in LRU cache promotes entry (side effect) -- FIXED

`browser/lru-cache.ts:42-52` -- checking existence changes eviction priority.

### 43. `MapRootLayout` naming

`server/root-layout.tsx` -- should be `DefaultRootLayout`.

### 44. Loader HMR re-registration silently ignored -- FIXED

`server/loader-registry.ts:49-53` -- keeps stale function during HMR.

### 45. `handle-store.ts` clones all data on every `push()` -- O(n^2)

`server/handle-store.ts:158` -- deep clone of accumulated handle data per push. Most clones are discarded.

### 46. Console debug log left in production code -- FIXED

`browser/partial-update.ts:206` -- `console.log("payload.metadata", payload.metadata)` on every navigation.

---

## Testing Gaps

### Critical: Source modules without unit tests

| Module | Risk | Notes |
|--------|------|-------|
| `browser/server-action-bridge.ts` | **CRITICAL** | Tree-structure-critical per CLAUDE.md. Zero unit tests. |
| `route-content-wrapper.tsx` | **CRITICAL** | Tree-structure-critical. LoaderBoundary/RouteContentWrapper. Zero unit tests. |
| `router/trie-matching.ts` | HIGH | Core routing algorithm, zero unit tests. |
| `browser/navigation-bridge.ts` | HIGH | Navigation-RSC bridge, zero unit tests. |
| `browser/navigation-client.ts` | HIGH | Client fetch lifecycle, zero unit tests. |
| `browser/request-controller.ts` | HIGH | RSC fetch/abort management, zero unit tests. |
| `browser/link-interceptor.ts` | HIGH | Click interception, zero unit tests. |
| `prerender/param-hash.ts` | ~~MEDIUM~~ | **DONE** -- 20 unit tests added. |
| `browser/lru-cache.ts` | MEDIUM | Pure data structure, trivial to test, zero unit tests. |
| `browser/scroll-restoration.ts` | MEDIUM | Zero unit or e2e tests. |

Browser React hooks (`use-action`, `use-navigation`, `use-segments`, `use-handle`, `use-link-status`, `use-client-cache`, `location-state`) have ~0 unit test coverage.

### CI Gaps

- **No linting** in CI (no ESLint job)
- **No coverage reporting** (no `--coverage` flag, no thresholds)
- **Single browser** (Chromium only; no Firefox/WebKit)
- **No `needs` dependencies** between typecheck/unit-tests and E2E jobs (no fail-fast)
- **No build caching** between CI jobs

### E2E Gaps

- No test for **scroll restoration** behavior
- No test for **concurrent navigation cancellation** (rapid link clicks)
- No test for **shallow navigation** (`shallow.ts`)
- No test for **Link-based client nav between prerendered routes** in production (tests use `page.goto()` only)
- No test for **history cache eviction** behavior with back/forward navigation
- No test for **use-link-status** / link prefetching

---

## Architecture Notes

### Files needing decomposition

| File | Lines | Suggestion |
|------|-------|------------|
| `src/rsc/handler.ts` | ~1500 | Split into: response-route-handler, progressive-enhancement, server-action-handler, loader-fetch-handler, rsc-render-handler |
| `src/vite/index.ts` (`createRouterDiscoveryPlugin`) | ~1130 | Extract: prerender logic, manifest generation, dev middleware |
| `src/vite/expose-internal-ids.ts` | ~1170 | Already well-structured internally, but could benefit from extracting the transform pipeline |

### Design strengths

- Segment-centric architecture is well-designed and the invariants are clearly documented
- Event controller unit tests are exceptionally thorough (697 lines)
- Type-level tests for route params, search params, and reverse routing catch type regressions at compile time
- E2E test infrastructure with `useFixture()` is clean and well-isolated
- Both dev and production modes tested in E2E
- Cache pipeline uses clean middleware composition pattern

### Design considerations

- The `loading` property's three-way semantics (undefined/null = none, false = suppressed, truthy = active) is the most fragile invariant in the system. Every code path that touches `loading` must preserve its category exactly. Consider extracting a `getLoadingCategory()` helper used everywhere.
- The CJS-to-ESM regex replacements in `createCjsToEsmPlugin` are brittle and will break on any update to `@vitejs/plugin-rsc` vendor files. Consider contributing ESM exports upstream.
- The `using` keyword with `Symbol.dispose` for navigation transactions is elegant but dangerous with fire-and-forget patterns. The dispose semantics conflict with async operations that outlive the scope.
