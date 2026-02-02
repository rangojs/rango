# Router Refactor Plan: Phase J with AsyncLocalStorage

## Status: ✅ Complete (All Steps J1-J13 Done)

**Goal:** Transform `matchPartial()` from ~780 lines into ~30 lines using AsyncLocalStorage for clean dependency access.

**Primary Objective:** Make router.ts more readable, maintainable, and beautiful.

---

## Methodology

### Core Principles

1. **Start from router.ts and work outward** - Begin with the main router entry point
2. **Small incremental steps** - Each step must be atomic and testable
3. **Mandatory test verification** - Run all tests after EVERY step
4. **No proceeding until green** - NEVER continue to the next step until ALL tests pass
5. **Edge cases must remain correct** - Critical to preserve all existing behavior

### Test Command

After EVERY step, run:

```bash
# Unit tests
cd packages/rsc-router && pnpm test:unit

# E2E tests (both apps)
cd packages/rsc-router && pnpm test --project=dev
cd examples/cloudflare-basic && pnpm test:e2e
```

### Changelog

After each step, append an entry to `MIGRATION_CHANGELOG.md` with:
- Step ID (e.g., J1, J2)
- Date/time
- What was changed
- Files modified
- Test results (pass/fail)
- Any edge cases discovered

---

## The Solution: AsyncLocalStorage

### The Problem (What We Tried Before)

External middleware files can't access closure variables from `createRSCRouter()`. Passing 20+ dependencies as parameters is ugly.

### The Solution

Use AsyncLocalStorage to make router dependencies available anywhere in the async call stack:

```typescript
// src/router/router-context.ts
import { AsyncLocalStorage } from "async_hooks";

export interface RouterDeps<TEnv = any> {
  findMatch: (pathname: string) => RouteMatchResult | null;
  loadManifest: (...) => Promise<EntryData>;
  traverseBack: (entry: EntryData) => Generator<EntryData>;
  // ... all closure functions
}

const routerContext = new AsyncLocalStorage<RouterDeps>();

export function getRouterDeps<TEnv>(): RouterDeps<TEnv> {
  const deps = routerContext.getStore();
  if (!deps) throw new Error("Not inside router context");
  return deps;
}

export function runWithRouterDeps<T>(deps: RouterDeps, fn: () => T): T {
  return routerContext.run(deps, fn);
}
```

### How It Works

```typescript
// In matchPartial()
async function matchPartial(request, context, actionContext) {
  const deps: RouterDeps = { findMatch, loadManifest, ... };

  return runWithRouterDeps(deps, async () => {
    // Everything inside can call getRouterDeps()!
    const ctx = await createMatchContext(request, context, actionContext);
    if (!ctx) return null;

    const pipeline = createMatchPartialPipeline(ctx);
    return collectMatchResult(pipeline, ctx);
  });
}
```

```typescript
// In any middleware file - NO deps parameter needed!
import { getRouterDeps } from "../router-context.js";

export function withCacheLookup(ctx, state) {
  return async function* (source) {
    const { evaluateRevalidation } = getRouterDeps();  // Just works!
    // ...
  };
}
```

---

## Target End State

### matchPartial() (~30 lines)

```typescript
async function matchPartial(
  request: Request,
  env: TEnv,
  actionContext?: ActionContext
): Promise<MatchResult | null> {
  const deps: RouterDeps = {
    findMatch, loadManifest, traverseBack, createHandlerContext,
    setupLoaderAccess, getContext, getMetricsStore, createCacheScope,
    findInterceptForRoute, resolveAllSegmentsWithRevalidationGenerator,
    resolveInterceptEntry, collectWithMarkers, evaluateRevalidation,
    getRequestContext, setupLoaderAccessSilent, resolveAllSegmentsGenerator,
    collectSegmentsFromGenerator, createHandleStore,
  };

  return runWithRouterDeps(deps, async () => {
    const ctx = await createMatchContext(request, env, actionContext);
    if (!ctx) return null;

    try {
      const pipeline = createMatchPartialPipeline(ctx);
      return await collectMatchResult(pipeline, ctx);
    } catch (error) {
      if (error instanceof Response) throw error;
      throw sanitizeError(error);
    }
  });
}
```

### Pipeline Composition

```typescript
function createMatchPartialPipeline(ctx: MatchContext) {
  return compose(
    withBackgroundRevalidation(ctx),  // Outermost - triggers SWR
    withCacheStore(ctx),               // Stores in cache
    withInterceptResolution(ctx),      // Handles intercepts
    withSegmentResolution(ctx),        // Resolves segments
    withCacheLookup(ctx),              // Innermost - checks cache first
  )(empty());
}
```

---

## File Structure

```
src/router/
├── router-context.ts         # NEW: AsyncLocalStorage + RouterDeps
├── match-context.ts          # NEW: MatchContext + createMatchContext()
├── match-result.ts           # NEW: collectMatchResult()
├── match-pipelines.ts        # NEW: createMatchPartialPipeline()
├── match-middleware/         # NEW: Middleware directory
│   ├── index.ts
│   ├── cache-lookup.ts       # withCacheLookup
│   ├── segment-resolution.ts # withSegmentResolution
│   ├── intercept-resolution.ts # withInterceptResolution
│   ├── cache-store.ts        # withCacheStore
│   └── background-revalidation.ts # withBackgroundRevalidation
└── generator-middleware.ts   # EXISTS: compose(), collect utilities
```

---

## Implementation Steps

### Step J1: Create router-context.ts ✅
- [x] Define `RouterContext<TEnv>` interface with all closure functions
- [x] Create AsyncLocalStorage instance
- [x] Export `getRouterContext()` and `runWithRouterContext()`
- [x] **RUN TESTS** - All 164 unit tests pass, all 315 e2e tests pass

### Step J2: Create match-context.ts ✅
- [x] Define `MatchContext<TEnv>` interface
- [x] Define `MatchPipelineState` interface
- [x] Define `ActionContext`, `CreateMatchContextInput`, `CreateMatchContextResult` types
- [x] Create `createPipelineState()` function
- [x] **RUN TESTS** - All tests pass

### Step J3: Create withCacheLookup middleware ✅
- [x] Check cache, yield cached segments if hit
- [x] Set state.cacheHit flag
- [x] Apply revalidation to cached segments
- [x] If miss, pass through to next middleware
- [x] Uses `getRouterContext()` for evaluateRevalidation
- [x] **RUN TESTS** - All tests pass

### Step J4: Create withSegmentResolution middleware ✅
- [x] Only runs if cache miss (state.cacheHit === false)
- [x] Uses `getRouterContext().resolveAllSegmentsWithRevalidation()`
- [x] Yields resolved segments
- [x] **RUN TESTS** - All tests pass

### Step J5: Create withInterceptResolution middleware ✅
- [x] Resolves intercept segments if ctx.interceptResult exists
- [x] Yields intercept segments after main segments
- [x] Uses `getRouterContext()` for resolveInterceptEntry
- [x] Handles cache hit with intercept scenario
- [x] **RUN TESTS** - All tests pass

### Step J6: Create withCacheStore middleware ✅
- [x] Observes all segments passing through
- [x] Stores in cache after pipeline completes
- [x] Handles proactive caching for null-component segments
- [x] **RUN TESTS** - All tests pass

### Step J7: Create withBackgroundRevalidation middleware ✅
- [x] If cache was stale, triggers SWR via waitUntil
- [x] Observes segments, doesn't modify
- [x] Uses `getRouterContext()` for background resolution
- [x] **RUN TESTS** - All tests pass

### Step J8: Create match-result.ts ✅
- [x] `collectSegments()` function
- [x] `buildMatchResult()` function
- [x] `collectMatchResult()` - main entry point
- [x] **RUN TESTS** - All tests pass

### Step J9: Create match-pipelines.ts ✅
- [x] `compose()` - compose multiple middleware into single middleware
- [x] `empty()` - create empty async generator as pipeline source
- [x] `createMatchPartialPipeline()` - compose all middleware
- [x] `createMatchPipeline()` - simpler pipeline for full match
- [x] Order: cache-lookup → segment-resolution → intercept → cache-store → SWR
- [x] **RUN TESTS** - All tests pass

### Step J10: Wire into matchPartial() ✅
- [x] Create `createMatchContextForPartial()` helper to extract ~230 lines of setup code
- [x] Build RouterContext object with all closure variables (19 functions)
- [x] Wrap in `runWithRouterContext()`
- [x] Call createMatchContextForPartial(), createMatchPartialPipeline(), collectMatchResult()
- [x] Fix middleware bugs (source iteration, loader resolution on cache hit)
- [x] **RUN TESTS** - Unit + ALL E2E tests pass

### Step J11: Wire into match() ✅
- [x] Create `createMatchContextForFull()` helper (simpler, no revalidation logic)
- [x] Add `isFullMatch` flag to MatchContext for differentiation
- [x] Update all middleware to handle both full and partial match
- [x] Refactor match() from ~220 lines to ~60 lines
- [x] **RUN TESTS** - Unit + ALL E2E tests pass

### Step J12: Wire into matchError() ✅
- [x] Reviewed matchError() - specialized error boundary logic doesn't fit pipeline pattern
- [x] Decision: Keep matchError() as-is (already concise and specialized)
- [x] No changes needed - function is already well-structured
- [x] **RUN TESTS** - All tests pass

### Step J13: Cleanup and Final Review ✅
- [x] Fixed all type errors (MetricsStore, RouteMatchResult exports)
- [x] Added RouteMatchResult export to pattern-matching.ts
- [x] Updated RouterContext interface to match actual function signatures
- [x] Final review for readability complete
- [x] **RUN TESTS** - Final verification (Unit + ALL E2E pass)

---

## Success Criteria

- [x] All 164 unit tests pass
- [x] All e2e tests pass (vite-rsc-demo: 289, cloudflare-basic: 54)
- [x] `matchPartial()` is ~45 lines (was ~780)
- [x] `match()` is ~60 lines (was ~220)
- [x] `matchError()` is concise and clear (kept as-is, specialized logic)
- [x] `match()` and `matchPartial()` use consistent RouterContext pattern
- [x] No functionality changes (pure refactor)
- [x] Code is readable and beautiful

---

## Benefits

1. **No parameter drilling** - Middleware uses `getRouterContext()` directly
2. **Clean separation** - Each middleware file is self-contained
3. **Testable** - Can mock router context in tests
4. **Type-safe** - Single `RouterContext` interface
5. **Beautiful** - All match* functions become ~30-50 lines each
6. **Extensible** - Easy to add new middleware (logging, tracing, etc.)
7. **Consistent** - Same pattern across match(), matchPartial(), matchError()

---

## Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| AsyncLocalStorage not available | Works in Node.js, Cloudflare Workers, Deno |
| Breaking edge cases | Test after EVERY step, never proceed until green |
| Large refactor | Small incremental steps, each independently testable |
| Middleware ordering bugs | Clear documentation of data flow |

---

## Existing Work to Preserve

From previous phases (A-I):
- `generator-middleware.ts` - compose(), collect utilities, marker types
- `resolveAllSegmentsWithRevalidationGenerator()` - Generator for revalidation
- `collectWithMarkers()` - Collect segments with ID markers
- All 164 unit tests and e2e tests

The AsyncLocalStorage approach builds on this foundation.
