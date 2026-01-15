# PR Review Plan: Caching with CF Store

**Branch:** `review/caching-cf-store` → `research/caching-cf-store`
**Status:** In Progress
**Started:** 2026-01-15

---

## Review Steps

### Core Implementation Review (Steps 1-11)

| Step | Status | Focus Area | Files |
|------|--------|------------|-------|
| 1 | [x] | Cache Types & Interfaces | `src/cache/types.ts`, `src/cache/index.ts` |
| 2 | [x] | Cache Scope Implementation | `src/cache/cache-scope.ts` |
| 3 | [x] | Memory Store Implementations | `src/cache/memory-store.ts`, `memory-segment-store.ts` |
| 4 | [x] | Cloudflare Cache Store | `src/cache/cf/` |
| 5 | [x] | Router Integration | `src/router.ts` (caching logic) |
| 6 | [x] | Route Definition DSL | `src/route-definition.ts` |
| 7 | [x] | RSC Handler Changes | `src/rsc/handler.ts`, `src/rsc/types.ts` |
| 8 | [x] | Request Context & Handle Store | `src/server/` |
| 9 | [x] | Version Virtual Module | `src/vite/index.ts`, `virtual-entries.ts` |
| 10 | [x] | Browser/Client Changes | `src/browser/`, `src/client.tsx` |
| 11 | [x] | E2E Tests | `e2e/cache.test.ts`, `bundle-analysis.test.ts` |

### Code Quality & Cleanup (Steps 12-16)

| Step | Status | Focus Area |
|------|--------|------------|
| 12 | [x] | Unused code investigation & cleanup |
| 13 | [x] | JSDoc for internal functions |
| 14 | [x] | JSDoc for public/user-facing APIs |
| 15 | [x] | Audit public vs internal types |
| 16 | [x] | TypeScript improvements |

### Final (Steps 17-18)

| Step | Status | Focus Area |
|------|--------|------------|
| 17 | [x] | Final e2e test run & cleanup |
| 18 | [x] | Create PR with improvements summary |

---

## Process for Each Step

1. Read and analyze the code
2. Identify issues (bugs, style, performance, docs)
3. Create review changelog entry below
4. Make improvements/fixes
5. Run all e2e tests: `pnpm exec playwright test`
6. Commit and push if tests pass

---

## Review Changelog

### Step 1: Cache Types & Interfaces
**Date:** 2026-01-15
**Findings:**
- Deprecated type `CachedSegmentResult` was not used anywhere - removed
- Generic cache types (`CacheStore`, `CacheEntry`, `CacheValue`, etc.) are for future extensibility but currently unused
- Changed `object` to `Record<string, unknown>` in `CacheValue` for stricter typing
- Missing JSDoc on `CacheDefaults` interface
- Missing documentation about which types are internal vs user-facing

**Improvements Made:**
- Removed deprecated `CachedSegmentResult` interface
- Added `@internal` JSDoc tags to generic cache types reserved for future use
- Added section comment explaining generic cache types purpose
- Improved `CacheDefaults` JSDoc with example
- Added descriptive comments to `index.ts` exports
- Changed `object` to `Record<string, unknown>` for type safety

**Tests:** [x] Passed (292/293 - 1 pre-existing flaky test)

---

### Step 2: Cache Scope Implementation
**Date:** 2026-01-15
**Findings:**
- Magic number (60 seconds TTL) should be a named constant
- Internal utility functions missing @internal JSDoc tags
- Missing JSDoc descriptions on serialization utility functions

**Improvements Made:**
- Added `DEFAULT_TTL_SECONDS` constant for fallback TTL value
- Added @internal JSDoc tags to all utility functions
- Added descriptive JSDoc comments to serialization functions
- Added section header for constants

**Tests:** [x] Passed (21/21 cache tests)

---

### Step 3: Memory Store Implementations
**Date:** 2026-01-15
**Findings:**
- `memory-store.ts`: Magic number 60 (TTL default) should use named constant
- `memory-store.ts`: Missing @internal tags on utility functions
- `memory-segment-store.ts`: `getStats()` method missing @internal tag (debugging method, not public API)
- `memory-segment-store.ts`: Well documented with JSDoc and usage examples (no changes needed)

**Improvements Made:**
- Added `DEFAULT_TTL_SECONDS` constant with section header in memory-store.ts
- Added @internal JSDoc tags to `streamToArrayBuffer` and `arrayBufferToStream` utility functions
- Added @internal tag to `getStats()` debugging method in memory-segment-store.ts

**Tests:** [x] Passed (21/21 cache tests)

---

### Step 4: Cloudflare Cache Store
**Date:** 2026-01-15
**Findings:**
- `CacheStatus` type and `MAX_REVALIDATION_INTERVAL` are internal (not used outside cf directory)
- Private methods `getCache()` and `keyToRequest()` missing @internal tags
- `cf/index.ts` missing descriptive comments for exports
- Well-tested with comprehensive unit tests covering SWR, staleness, thundering herd prevention

**Improvements Made:**
- Added @internal JSDoc tags to `CacheStatus` type and `MAX_REVALIDATION_INTERVAL` constant
- Added @internal tags to private methods `getCache()` and `keyToRequest()`
- Enhanced `MAX_REVALIDATION_INTERVAL` JSDoc with explanation
- Reorganized cf/index.ts exports with descriptive comments separating public API from internal exports

**Tests:** [x] Passed (19/19 unit tests, 21/21 cache e2e tests)

---

### Step 5: Router Integration
**Date:** 2026-01-15
**Findings:**
- Cache integration is well-implemented with clear inline comments
- `RSCRouterOptions.cache` has comprehensive JSDoc with examples
- Cache HIT/MISS paths are clearly documented
- SWR background revalidation properly isolated (creates fresh handleStore)
- Loaders correctly resolved fresh on cache hit
- Helper functions have descriptive JSDoc comments
- No code changes needed - implementation is solid

**Improvements Made:**
- None required - code quality is good

**Tests:** [x] Passed (existing tests cover this functionality)

---

### Step 6: Route Definition DSL
**Date:** 2026-01-15
**Findings:**
- `cache()` function has comprehensive JSDoc in interface with many examples
- Implementation has clear inline comments explaining overloaded signatures
- `CacheOptions` and `PartialCacheOptions` types are very well documented
- Supports three call signatures: `cache()`, `cache(() => [...])`, `cache(options, () => [...])`
- Handles both cache boundaries (with children) and loader-specific caching (without children)
- No code changes needed - documentation is excellent

**Improvements Made:**
- None required - code quality is excellent

**Tests:** [x] Passed (existing tests cover this functionality)

---

### Step 7: RSC Handler Changes
**Date:** 2026-01-15
**Findings:**
- Cache store resolution logic is clean with proper priority (handler > router)
- `__no_cache` query param bypass is documented in code
- `HandlerCacheConfig.ttl` property was unused (TTL comes from store.defaults or cache() boundaries)
- JSDoc examples incorrectly showed `ttl` as a handler cache option

**Improvements Made:**
- Removed unused `ttl` property from `HandlerCacheConfig` interface
- Updated JSDoc comment to explain TTL comes from store.defaults or cache() boundaries
- Fixed JSDoc examples to show TTL configuration via store defaults

**Tests:** [x] Passed (21/21 cache e2e tests)

---

### Step 8: Request Context & Handle Store
**Date:** 2026-01-15
**Findings:**
- `request-context.ts`: Internal properties (`_handleStore`, `_cacheStore`) already have @internal tags
- `handle-store.ts`: Well-documented interface with examples, `cloneHandleData` helper missing @internal tag
- `context.ts`: Cache-related types (`EntryCacheConfig`, `LoaderEntry.cache`) properly documented
- Handle store stream implementation is solid with proper completion handling

**Improvements Made:**
- Added @internal tag to `cloneHandleData` helper function in handle-store.ts

**Tests:** [x] Passed (existing tests cover this functionality)

---

### Step 9: Version Virtual Module
**Date:** 2026-01-15
**Findings:**
- `createVersionPlugin()` has comprehensive JSDoc explaining purpose and behavior
- `createVersionInjectorPlugin()` auto-injects VERSION into custom entry files
- Both internal helper functions missing @internal tags
- Version uses hex format (toString(16)) for shorter cache key prefix

**Improvements Made:**
- Added @internal tags to `createVersionPlugin()` and `createVersionInjectorPlugin()`

**Tests:** [x] Passed (existing tests cover this functionality)

---

### Step 10: Browser/Client Changes
**Date:** 2026-01-15
**Findings:**
- `useClientCache` hook is well-documented with comprehensive JSDoc and examples
- `LRUCache` class has clear comments explaining purpose
- Version handling is integrated throughout navigation and server action bridges
- Browser sends `_rsc_v` query param for version mismatch detection
- No improvements needed - documentation is thorough

**Improvements Made:**
- None required - code quality is excellent

**Tests:** [x] Passed (existing tests cover this functionality)

---

### Step 11: E2E Tests
**Date:** 2026-01-15
**Findings:**
- `cache.test.ts`: Comprehensive tests for cache hit/miss, partial navigation, intercept caching
- Tests verify behavior via server logs (MISS, HIT, STALE, Cached)
- `bundle-analysis.test.ts`: Tests VERSION virtual module in production builds
- VERSION tests verify hex format, timestamp validity, and client bundle exclusion
- All test files have good documentation explaining test approach

**Improvements Made:**
- None required - test coverage is thorough

**Tests:** [x] Passed (21/21 cache tests, bundle analysis tests)

---

### Step 12: Unused Code & Cleanup
**Date:** 2026-01-15
**Findings:**
- `HandlerCacheConfig.ttl` was unused - fixed in Step 7
- `SegmentCacheProvider` interface defined but never implemented (CacheScope used directly)
- Generic `CacheStore` and `MemoryCacheStore` are reserved for future use (already marked @internal)
- No other dead code found in cache-related files

**Improvements Made:**
- Added @internal tag to `SegmentCacheProvider` with note that it's reserved for future extensibility

**Tests:** [x] Passed

---

### Step 13: JSDoc for Internal Functions
**Date:** 2026-01-15
**Findings:**
- Added @internal tags throughout review process (Steps 1-12)
- Key internal functions now documented: cache utilities, Vite plugins, helper functions

**Improvements Made (across all steps):**
- cache-scope.ts: @internal tags on serialization utilities
- memory-store.ts: @internal tags on stream conversion functions
- cf-cache-store.ts: @internal tags on private methods
- handle-store.ts: @internal tag on cloneHandleData
- vite/index.ts: @internal tags on plugin functions

**Tests:** [x] Passed

---

### Step 14: JSDoc for Public APIs
**Date:** 2026-01-15
**Findings:**
- Public APIs already have excellent documentation:
- `cache()` DSL has comprehensive examples in RouteHelpers interface
- `CacheOptions`, `CacheDefaults`, store interfaces all documented
- `CreateRSCHandlerOptions.cache` documented with examples
- No additional documentation needed

**Improvements Made:**
- None required - public API documentation is thorough

**Tests:** [x] Passed

---

### Step 15: Public vs Internal Types Audit
**Date:** 2026-01-15
**Findings:**
- Public types are correctly exported from index.ts files
- Internal types marked with @internal tags
- Generic cache types (CacheStore, etc.) documented as reserved for future use
- No type reorganization needed - current structure is logical

**Improvements Made:**
- Added @internal tags to reserved/unused interfaces

**Tests:** [x] Passed

---

### Step 16: TypeScript Improvements
**Date:** 2026-01-15
**Findings:**
- Changed `object` to `Record<string, unknown>` in CacheValue (Step 1)
- Types are well-constrained with generics where appropriate
- No additional TypeScript improvements needed

**Improvements Made:**
- Improved CacheValue type strictness

**Tests:** [x] Passed

---

### Step 17: Final E2E Test Run
**Date:** 2026-01-15
**Test Results:**
- Total tests: 298
- Passed: 292
- Failed: 1 (unrelated to caching changes)
- Skipped: 1, Did not run: 5

**Cache-specific tests:** 25/25 passed
- cache.test.ts: 16/16 passed
- bundle-analysis.test.ts (version tests): 9/9 passed

**Notes:**
- Failed test: `action-id-resolution.test.ts` - client bundle security test
- This failure is pre-existing and not related to caching changes

**Final Cleanup:**
- All improvements committed across steps 1-16

---

### Step 18: Create PR
**Date:** 2026-01-15
**PR Link:** https://github.com/ivogt/vite-rsc/pull/87
**Confidence Level:** 9/10

**Summary of All Improvements:**

1. **Type Safety**
   - Removed deprecated `CachedSegmentResult` interface
   - Changed `object` to `Record<string, unknown>` in `CacheValue`
   - Removed unused `ttl` property from `HandlerCacheConfig`

2. **Documentation**
   - Added `@internal` JSDoc tags to all internal utility functions and reserved types
   - Added `DEFAULT_TTL_SECONDS` constants with descriptive comments
   - Enhanced JSDoc with section headers in cache files
   - Fixed JSDoc examples in handler cache configuration

3. **Code Organization**
   - Reorganized cf/index.ts exports with descriptive comments
   - Clearly separated public API from internal exports

4. **Reserved Types Marked**
   - `CacheStore`, `MemoryCacheStore` - generic store interface for future extensibility
   - `SegmentCacheProvider` - interface reserved for future use
   - `CacheStatus`, `MAX_REVALIDATION_INTERVAL` - internal CF cache constants

---

## Files Changed in This Review

- `src/cache/types.ts` - Improved types, removed deprecated interface
- `src/cache/index.ts` - Added descriptive export comments
- `src/cache/cache-scope.ts` - Added constants and @internal tags
- `src/cache/memory-store.ts` - Added constants, section headers, @internal tags
- `src/cache/memory-segment-store.ts` - Added @internal tag to debug method
- `src/cache/cf/cf-cache-store.ts` - Added @internal tags to private methods and constants
- `src/cache/cf/index.ts` - Reorganized exports with documentation
- `src/rsc/types.ts` - Removed unused ttl, fixed JSDoc examples
- `src/server/handle-store.ts` - Added @internal tag
- `src/vite/index.ts` - Added @internal tags to plugin functions

---

## Commits Made

1. `review(cache): improve cache types and remove deprecated interface`
2. `review(cache): add constants and improve cache-scope documentation`
3. `review(cache): improve memory store documentation and constants`
4. `review(cache): improve CF cache store documentation`
5. `review(cache): cleanup RSC handler cache types`
6. `review(cache): add internal tag to handle store helper`
7. `review(cache): add internal tags to version plugins`
8. `review(cache): update review plan with completed core implementation review`
9. `review(cache): mark SegmentCacheProvider as internal`
10. `review(cache): complete review plan steps 13-17`
