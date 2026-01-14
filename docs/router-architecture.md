# Router Architecture Analysis

This document maps the logical flow of `router.ts` (~3800 lines) to aid refactoring into more maintainable modules.

## File Overview

| Lines | Section | Description |
|-------|---------|-------------|
| 1-90 | Imports & Types | Dependencies and type definitions |
| 91-404 | Router Interface | Public API type definitions |
| 406-560 | Router Factory Start | `createRSCRouter()`, middleware, helpers |
| 562-740 | Loader Resolution | `resolveLoaders`, `resolveLoadersWithRevalidation` |
| 741-940 | Segment Resolution | `resolveSegment`, `resolveOrphanLayout` |
| 944-1230 | Intercept Handling | `findInterceptForRoute`, `resolveInterceptEntry` |
| 1231-1360 | Intercept Loaders | `resolveInterceptLoadersOnly` |
| 1359-1520 | Parallel Segments | `resolveParallelEntry`, `resolveWithErrorHandling` |
| 1517-1640 | Batch Resolution | `resolveAllSegments`, `resolveLoadersOnly` |
| 1644-2430 | Revalidation Logic | All `*WithRevalidation` functions |
| 2433-2660 | Full Match | `match()` - document/SSR requests |
| 2662-2830 | Error Matching | `matchError()` - error boundary resolution |
| 2833-3600 | Partial Match | `matchPartial()` - navigation/actions |
| 3603-3650 | Preview Match | `previewMatch()` - middleware preview |
| 3655-3779 | Route Builder | Route registration and builder API |

---

## Core Entry Points

### 1. `match(request, context)` - Full Document Render
**Purpose**: SSR / hard navigation (direct URL access)

```
Request → Route Matching → Load Manifest → Resolve All Segments → Return MatchResult
```

**Key steps:**
1. Parse URL pathname
2. `findMatch(pathname)` → get route entry + params
3. Handle trailing slash redirects
4. `loadManifest()` → lazy load route handler module
5. Collect middleware (app-level + route-level)
6. `resolveAllSegments()` → render all layouts/routes
7. Return segments + metadata

### 2. `matchPartial(request, context, actionContext?)` - Navigation/Actions
**Purpose**: Client-side navigation, server actions

```
Request → Extract Client State → Route Matching → Revalidation Check →
  → Cache Lookup → Resolve Changed Segments → Return Diff
```

**This is the most complex function (~770 lines)**

---

## `matchPartial` Detailed Flow

### Phase 1: Request Parsing (lines 2843-2876)
```typescript
// Extract from request:
- pathname from URL
- clientSegmentIds from `_rsc_segments` param
- stale flag from `_rsc_stale` param
- previousUrl from `X-RSC-Router-Client-Path` header
- interceptSourceUrl from `X-RSC-Router-Intercept-Source` header
```

**Decision Point**: No previousUrl → return null (fall back to full render)

### Phase 2: Route Matching (lines 2877-2924)
```typescript
prevMatch = findMatch(prevUrl.pathname)
matched = findMatch(pathname)
```

**Decision Points:**
- No match → throw `RouteNotFoundError`
- Redirect needed → return null (fall back to full render)
- Route group changed (different entry) → return null (segment IDs incompatible)

### Phase 3: Context Setup (lines 2926-2984)
```typescript
- loadManifest(matched.entry) → lazy load handler
- collectRouteMiddleware() → gather route-level middleware
- createHandlerContext() → request context for handlers
- Create loaderPromises map for parallel execution
- setupLoaderAccess() → enable ctx.use() in handlers
```

### Phase 4: Intercept Detection (lines 2986-3075)
```typescript
// Check if this navigation should trigger an intercept route
isSameRouteNavigation = interceptContextMatch?.routeKey === matched.routeKey

// Skip intercept if:
- Same route navigation (product/a → product/b)
- Action without intercept segments in client

interceptResult = findInterceptForRoute(routeKey, parentEntry, selectorContext)
```

**Intercept Logic:**
- Intercepts activate on soft navigation from different routes
- They render in named slots (@modal, @sidebar)
- Replace route handler, keep layouts

### Phase 5: Cache Handling (lines 3084-3431)

#### Cache Lookup (lines 3096-3100)
```typescript
cacheResult = cacheScope?.lookupRoute(pathname, params, isIntercept)
```

#### Branch A: Cache HIT (lines 3104-3250)
```typescript
1. Get cached segments
2. Apply revalidation to cached segments:
   - For each segment client has:
     - Evaluate revalidation rules
     - If no revalidation needed: set component = null
3. Resolve loaders fresh (loaders NOT cached)
4. Combine: cached segments + fresh loaders
5. If stale (SWR): trigger background revalidation via waitUntil()
```

#### Branch B: Cache MISS (lines 3251-3431)
```typescript
1. resolveAllSegmentsWithRevalidation():
   - For each entry in manifest chain:
     - Skip route if intercepting
     - resolveSegmentWithRevalidation():
       a. resolveLoadersWithRevalidation()
       b. resolveOrphanLayoutWithRevalidation() (for routes)
       c. resolveParallelSegmentsWithRevalidation()
       d. resolveEntryHandlerWithRevalidation()

2. If intercept: resolveInterceptEntry()

3. Cache for future (if enabled):
   - If has null components: proactive cache in background
   - Else: cache directly
```

### Phase 6: Intercept Resolution for Cache Hits (lines 3435-3539)
```typescript
// For cache hits that need intercept:
- Extract intercept segments from cache
- Re-resolve intercept loaders for fresh data
- Update slots metadata
```

### Phase 7: Final Assembly (lines 3541-3600)
```typescript
allSegments = [...segments, ...interceptSegments]

// Filter to only segments that need rendering
segmentsToRender = allSegments.filter(s =>
  s.component !== null || s.type === "loader"
)

return {
  segments: segmentsToRender,
  matched: allIds,
  diff: segmentsToRender.map(s => s.id),
  params,
  slots,
  routeMiddleware
}
```

---

## Revalidation System

### `evaluateRevalidation()` (in router/revalidation.ts)
Determines if a segment needs re-rendering:

```typescript
// Default: revalidate if params changed (for route segments)
// Custom: execute revalidate() functions from route definition

revalidate(({ params, prevParams, request, ... }) => {
  return params.id !== prevParams.id; // true = re-render
})
```

### Revalidation Flow per Segment
```
1. Check if client already has segment (in clientSegmentSet)
2. If yes, evaluate revalidation rules:
   - No rules + belongs to route: check params changed
   - Has rules: execute each rule
3. If shouldRevalidate = false: set component = null (skip rendering)
```

---

## Segment Types

| Type | Description | Has Component | Has Loaders |
|------|-------------|---------------|-------------|
| `layout` | Wrapping layout component | Yes | Yes |
| `route` | Route handler component | Yes | Yes |
| `parallel` | Named slot (@modal, etc) | Yes | Yes |
| `loader` | Data loader (no UI) | No | N/A |
| `cache` | Cache boundary | Optional | Yes |

---

## Key Helper Functions

### Resolution Functions
| Function | Purpose |
|----------|---------|
| `resolveAllSegments` | Render all segments (full match) |
| `resolveAllSegmentsWithRevalidation` | Render with revalidation logic |
| `resolveSegment` | Render single segment |
| `resolveSegmentWithRevalidation` | Segment + revalidation |
| `resolveLoaders` | Execute loaders |
| `resolveLoadersWithRevalidation` | Loaders + revalidation |
| `resolveParallelEntry` | Render parallel slot |
| `resolveOrphanLayout` | Render inline layout |
| `resolveInterceptEntry` | Render intercept components |

### Lookup Functions
| Function | Purpose |
|----------|---------|
| `findMatch` | Match URL to route entry |
| `findInterceptForRoute` | Find intercept for route |
| `findNearestErrorBoundary` | Find error boundary |
| `findNearestNotFoundBoundary` | Find not found boundary |

### Error Handling
| Function | Purpose |
|----------|---------|
| `resolveWithErrorHandling` | Wrap resolution with error boundary |
| `resolveWithRevalidationErrorHandling` | Same for revalidation path |
| `createErrorSegment` | Create error UI segment |
| `createNotFoundSegment` | Create 404 UI segment |

---

## Potential Refactoring Modules

Based on the analysis, router.ts could be split into:

### 1. `router/match-full.ts`
- `match()` function
- Full document rendering logic

### 2. `router/match-partial.ts`
- `matchPartial()` function
- Navigation/action handling

### 3. `router/match-error.ts`
- `matchError()` function
- Error boundary resolution

### 4. `router/segment-resolver.ts`
- All `resolveSegment*` functions
- All `resolveLoaders*` functions
- All `resolve*WithRevalidation` functions

### 5. `router/intercept-resolver.ts`
- `findInterceptForRoute()`
- `resolveInterceptEntry()`
- `resolveInterceptLoadersOnly()`
- `evaluateInterceptWhen()`

### 6. `router/cache-handler.ts`
- Cache lookup logic
- Proactive caching
- SWR revalidation

### 7. `router/parallel-resolver.ts`
- `resolveParallelEntry()`
- `resolveParallelSegmentsWithRevalidation()`

### 8. `router/builder.ts` (already partially extracted)
- Route builder API
- Route registration

---

## Async Iterator Approach

Current architecture uses async generators for:
- Handle data streaming (`handleStore`)
- Loader data promises

Benefits:
- Progressive rendering
- Non-blocking data loading
- Natural cancellation

Could extend to:
- Segment resolution pipeline
- Cache operations
- Middleware chain

---

## Complexity Hotspots

### 1. `matchPartial` (770 lines)
**Issues:**
- Too many responsibilities
- Deep nesting (cache hit/miss branches)
- Duplicated logic between branches

**Refactor approach:**
- Extract cache handling to separate functions
- Use strategy pattern for hit/miss paths
- Break into phases as separate functions

### 2. Revalidation Logic (scattered)
**Issues:**
- Similar patterns repeated across functions
- Hard to trace revalidation flow

**Refactor approach:**
- Centralize revalidation decision
- Use decorator pattern for revalidation wrapper

### 3. Intercept Handling (complex conditionals)
**Issues:**
- Multiple conditions for when to intercept
- Logic split between detection and resolution

**Refactor approach:**
- Create InterceptContext object
- Single source of truth for intercept state

---

## Deep Analysis: Core Abstractions

### Current State: God Function Problem

`matchPartial` is a 770-line function because it handles multiple orthogonal concerns:

```
┌─────────────────────────────────────────────────────────────────┐
│                        matchPartial()                            │
├─────────────────────────────────────────────────────────────────┤
│  1. Request parsing (headers, params)                            │
│  2. Route matching (URL → entry)                                 │
│  3. Intercept detection (soft nav logic)                         │
│  4. Cache lookup/storage                                         │
│  5. Revalidation evaluation                                      │
│  6. Segment resolution                                           │
│  7. Loader execution                                             │
│  8. Background tasks (SWR, proactive cache)                      │
│  9. Error boundary finding                                       │
│  10. Metrics collection                                          │
│  11. Result assembly                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Architecture: Pipeline Pattern

```
Request
    │
    ▼
┌───────────────┐
│ MatchPhase    │ → RouteMatch { entry, params, routeKey }
└───────────────┘
    │
    ▼
┌───────────────┐
│ PlanPhase     │ → ResolutionPlan { segments[], intercept?, cache? }
└───────────────┘
    │
    ▼
┌───────────────┐
│ ResolvePhase  │ → ResolvedSegment[]
└───────────────┘
    │
    ▼
┌───────────────┐
│ DiffPhase     │ → SegmentDiff { toRender[], toKeep[], toRemove[] }
└───────────────┘
    │
    ▼
MatchResult
```

---

## Pattern 1: Resolution Pipeline with Async Iterators

Instead of nested function calls, use a pipeline:

```typescript
// Current approach (nested, hard to follow)
const result = await resolveAllSegmentsWithRevalidation(
  entries,
  routeKey,
  params,
  context,
  clientSegmentSet,
  prevParams,
  request,
  prevUrl,
  url,
  loaderPromises,
  actionContext,
  interceptResult,
  localRouteName,
  pathname
);

// Pipeline approach
const pipeline = createResolutionPipeline({
  entries,
  routeKey,
  params,
  context,
});

// Each step yields segments as they're resolved
for await (const segment of pipeline) {
  if (shouldRevalidate(segment, clientSegmentSet, prevParams)) {
    yield await resolveSegment(segment);
  } else {
    yield createSkippedSegment(segment);
  }
}
```

### Benefits of Async Iterator Pipeline

1. **Streaming**: Segments can be sent to client as resolved
2. **Cancellation**: Natural abort on navigation change
3. **Composability**: Pipeline steps can be added/removed
4. **Testing**: Each step testable in isolation
5. **Debugging**: Can log each step independently

---

## Pattern 1b: Async Generator as Middleware

The async generator pattern can be extended to work like middleware - wrapping, intercepting, and processing yields at any point (before, during, after).

### Core Concept: Generator Middleware

```typescript
// A middleware is a function that wraps a generator and returns a new generator
type GeneratorMiddleware<T> = (
  source: AsyncGenerator<T>
) => AsyncGenerator<T>;

// Compose multiple middlewares (right-to-left, like function composition)
function composeMiddleware<T>(
  ...middlewares: GeneratorMiddleware<T>[]
): GeneratorMiddleware<T> {
  return (source) =>
    middlewares.reduceRight((gen, middleware) => middleware(gen), source);
}
```

### Middleware Examples

#### 1. Logging Middleware (observe all yields)
```typescript
async function* withLogging<T extends { id: string }>(
  source: AsyncGenerator<T>
): AsyncGenerator<T> {
  console.log('[Pipeline] Starting');
  let count = 0;

  for await (const item of source) {
    count++;
    console.log(`[Pipeline] Yielded #${count}: ${item.id}`);
    yield item;
  }

  console.log(`[Pipeline] Complete: ${count} items`);
}
```

#### 2. Revalidation Middleware (filter/transform)
```typescript
function withRevalidation(
  clientSegments: Set<string>,
  prevParams: Record<string, string>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    for await (const segment of source) {
      if (clientSegments.has(segment.id)) {
        const shouldRevalidate = await evaluateRevalidation(segment, prevParams);
        if (!shouldRevalidate) {
          yield { ...segment, component: null }; // Client has it, skip render
          continue;
        }
      }
      yield segment;
    }
  };
}
```

#### 3. Cancellation Middleware (short-circuit)
```typescript
function withCancellation<T>(signal: AbortSignal): GeneratorMiddleware<T> {
  return async function* (source) {
    for await (const item of source) {
      if (signal.aborted) {
        console.log('[Pipeline] Aborted by signal');
        return; // Stop iteration entirely
      }
      yield item;
    }
  };
}
```

#### 4. Cache Middleware (intercept + side effects)
```typescript
function withCaching(
  cacheStrategy: CacheStrategy,
  cacheKey: string
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    const collected: ResolvedSegment[] = [];

    // Pass through all items, collecting them
    for await (const segment of source) {
      collected.push(segment);
      yield segment;
    }

    // After all items yielded, cache them (side effect at end)
    await cacheStrategy.store(cacheKey, collected);
    console.log(`[Cache] Stored ${collected.length} segments`);
  };
}
```

#### 5. Batching Middleware (collect + emit)
```typescript
function withBatching<T>(batchSize: number): GeneratorMiddleware<T> {
  return async function* (source) {
    const batch: T[] = [];

    for await (const item of source) {
      batch.push(item);
      if (batch.length >= batchSize) {
        yield* batch; // Emit all at once
        batch.length = 0;
      }
    }

    // Emit remaining
    if (batch.length > 0) {
      yield* batch;
    }
  };
}
```

#### 6. Error Boundary Middleware (catch + recover)
```typescript
function withErrorBoundary(
  findBoundary: (error: Error) => ErrorBoundary | null
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    try {
      yield* source;
    } catch (error) {
      const boundary = findBoundary(error);
      if (boundary) {
        yield createErrorSegment(error, boundary);
      } else {
        throw error; // Re-throw if no boundary
      }
    }
  };
}
```

#### 7. Metrics Middleware (timing + collection)
```typescript
function withMetrics(
  metricsStore: MetricsStore
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    const startTime = performance.now();
    let segmentCount = 0;

    for await (const segment of source) {
      const segmentStart = performance.now();
      yield segment;

      metricsStore.record({
        label: `segment:${segment.id}`,
        duration: performance.now() - segmentStart,
      });
      segmentCount++;
    }

    metricsStore.record({
      label: 'total-resolution',
      duration: performance.now() - startTime,
      count: segmentCount,
    });
  };
}
```

### Composing the Pipeline

```typescript
// Define the base resolution generator
async function* resolveEntries(
  entries: EntryData[],
  context: ResolutionContext
): AsyncGenerator<ResolvedSegment> {
  for (const entry of entries) {
    yield* resolveEntry(entry, context);
  }
}

// Compose middlewares into pipeline
function createResolutionPipeline(
  entries: EntryData[],
  context: ResolutionContext,
  options: PipelineOptions
): AsyncGenerator<ResolvedSegment> {
  const {
    clientSegments,
    prevParams,
    signal,
    cacheStrategy,
    cacheKey,
    metricsStore,
  } = options;

  // Build middleware stack (applied right-to-left)
  const pipeline = composeMiddleware(
    // Outermost: metrics wraps everything
    withMetrics(metricsStore),
    // Cancellation check
    withCancellation(signal),
    // Error handling
    withErrorBoundary(findNearestBoundary),
    // Caching (collects at end)
    withCaching(cacheStrategy, cacheKey),
    // Revalidation filter
    withRevalidation(clientSegments, prevParams),
    // Logging (innermost, sees raw yields)
    withLogging,
  );

  // Apply to base generator
  return pipeline(resolveEntries(entries, context));
}

// Usage in matchPartial
async function matchPartial(request, context) {
  // ... setup ...

  const pipeline = createResolutionPipeline(entries, handlerContext, {
    clientSegments: clientSegmentSet,
    prevParams,
    signal: request.signal,
    cacheStrategy,
    cacheKey: pathname,
    metricsStore,
  });

  const segments: ResolvedSegment[] = [];
  for await (const segment of pipeline) {
    segments.push(segment);
  }

  return { segments, matched: segments.map(s => s.id) };
}
```

### Advanced: Branching Middleware

For intercepts, we need to conditionally branch the pipeline:

```typescript
function withIntercept(
  interceptResult: InterceptResult | null,
  resolveIntercept: () => AsyncGenerator<ResolvedSegment>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    // Yield main segments, but skip route if intercepting
    for await (const segment of source) {
      if (segment.type === 'route' && interceptResult) {
        // Don't yield route component, but track the ID
        yield { ...segment, component: null, intercepted: true };
      } else {
        yield segment;
      }
    }

    // After main segments, yield intercept segments
    if (interceptResult) {
      yield* resolveIntercept();
    }
  };
}
```

### Advanced: Fork/Join Middleware

For parallel resolution:

```typescript
function withParallelSlots(
  resolveParallel: (entry: ParallelEntry) => AsyncGenerator<ResolvedSegment>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    const parallelGenerators: AsyncGenerator<ResolvedSegment>[] = [];

    for await (const segment of source) {
      yield segment;

      // Collect parallel slots to resolve
      if (segment.parallels) {
        for (const parallel of segment.parallels) {
          parallelGenerators.push(resolveParallel(parallel));
        }
      }
    }

    // Resolve all parallels concurrently, yield as they complete
    yield* mergeAsyncGenerators(parallelGenerators);
  };
}

// Helper: merge multiple async generators into one
async function* mergeAsyncGenerators<T>(
  generators: AsyncGenerator<T>[]
): AsyncGenerator<T> {
  const pending = generators.map(async (gen, i) => ({ i, gen, result: await gen.next() }));

  while (pending.length > 0) {
    const { i, gen, result } = await Promise.race(pending.map(p => p));

    if (result.done) {
      pending.splice(pending.findIndex(p => p.i === i), 1);
    } else {
      yield result.value;
      pending[pending.findIndex(p => p.i === i)] = { i, gen, result: await gen.next() };
    }
  }
}
```

### Benefits of Generator Middleware Pattern

| Aspect | Traditional | Generator Middleware |
|--------|-------------|---------------------|
| **Composition** | Nested function calls | Linear pipeline |
| **Testing** | Mock entire context | Test each middleware |
| **Debugging** | Step through 770 lines | Inspect per-middleware |
| **Reusability** | Copy-paste code | Plug-and-play middlewares |
| **Cancellation** | Check flags everywhere | Single middleware |
| **Side Effects** | Scattered throughout | Explicit in middleware |
| **Timing** | Manual instrumentation | Metrics middleware |
| **Error Handling** | Try-catch blocks | Error boundary middleware |

### Execution Model Comparison

```
Current (Nested Calls):
┌─────────────────────────────────────────┐
│ matchPartial                            │
│  ├─ resolveAllSegmentsWithRevalidation  │
│  │   ├─ resolveSegmentWithRevalidation  │
│  │   │   ├─ resolveLoadersWithReval...  │
│  │   │   ├─ resolveParallelsWith...     │
│  │   │   └─ resolveEntryHandlerWith...  │
│  │   └─ (repeat for each entry)         │
│  ├─ resolveInterceptEntry               │
│  └─ cacheScope.cacheRoute               │
└─────────────────────────────────────────┘

Generator Middleware (Pipeline):
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Metrics  │ → │ Cancel   │ → │ Error    │ → │ Cache    │ →
└──────────┘   └──────────┘   └──────────┘   └──────────┘
     ↓
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Reval    │ → │ Intercept│ → │ Logging  │ → │ Resolve  │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
```

---

## Pattern 2: Strategy for Cache Handling

```typescript
interface CacheStrategy {
  lookup(key: CacheKey): Promise<CachedSegments | null>;
  store(key: CacheKey, segments: ResolvedSegment[]): Promise<void>;
  shouldRevalidate(result: CachedResult): boolean;
}

class EdgeCacheStrategy implements CacheStrategy {
  // Cloudflare Cache API
}

class MemoryCacheStrategy implements CacheStrategy {
  // In-memory for development
}

class NoCacheStrategy implements CacheStrategy {
  // Passthrough for actions
}

// Usage in matchPartial:
const cacheStrategy = selectCacheStrategy(request, cacheScope);
const cached = await cacheStrategy.lookup(cacheKey);

if (cached) {
  return await handleCacheHit(cached, cacheStrategy);
} else {
  return await handleCacheMiss(cacheStrategy);
}
```

---

## Pattern 3: State Machine for Navigation

Model navigation as explicit states:

```typescript
type NavigationState =
  | { type: 'idle' }
  | { type: 'matching'; request: Request }
  | { type: 'resolving'; match: RouteMatch; plan: ResolutionPlan }
  | { type: 'streaming'; segments: AsyncIterator<ResolvedSegment> }
  | { type: 'complete'; result: MatchResult }
  | { type: 'error'; error: Error; boundary: ErrorBoundary };

const navigationMachine = createMachine<NavigationState>({
  idle: {
    NAVIGATE: 'matching',
  },
  matching: {
    MATCHED: 'resolving',
    NO_MATCH: 'error',
    REDIRECT: 'idle', // triggers new navigation
  },
  resolving: {
    CACHE_HIT: 'streaming',
    CACHE_MISS: 'streaming',
    ERROR: 'error',
  },
  // ...
});
```

### Benefits
- Explicit state transitions
- Impossible states become unrepresentable
- Easy to add logging/debugging
- Natural integration with React Suspense

---

## Pattern 4: Visitor for Entry Tree

Current code has scattered tree traversal:

```typescript
// Current: imperative traversal repeated everywhere
for (const entry of entries) {
  if (entry.type === "route" && interceptResult) {
    // handle intercept
  }
  // resolve entry...
  if (entry.type === "route") {
    for (const orphan of entry.layout) {
      // handle orphan...
    }
  }
  // parallels...
}
```

Visitor pattern:

```typescript
interface EntryVisitor<T> {
  visitLayout(entry: LayoutEntry): T;
  visitRoute(entry: RouteEntry): T;
  visitParallel(entry: ParallelEntry): T;
  visitCache(entry: CacheEntry): T;
  visitLoader(entry: LoaderEntry): T;
}

class SegmentResolver implements EntryVisitor<Promise<ResolvedSegment[]>> {
  constructor(private context: ResolutionContext) {}

  async visitLayout(entry: LayoutEntry) {
    const loaders = await this.resolveLoaders(entry);
    const component = await this.resolveComponent(entry);
    const parallels = await this.visitAll(entry.parallel);
    const orphans = await this.visitAll(entry.layout);
    return [component, ...loaders, ...parallels.flat(), ...orphans.flat()];
  }

  // ... other visit methods
}

// Usage
const visitor = new SegmentResolver(context);
const segments = await traverseEntry(manifestEntry, visitor);
```

---

## Pattern 5: Dependency Injection for Testability

Current functions have many implicit dependencies:

```typescript
// Current: tightly coupled
async function matchPartial(request, context, actionContext) {
  const metricsStore = getMetricsStore(); // global
  const Store = getContext().getOrCreateStore(routeKey); // global
  const requestCtx = getRequestContext(); // global
  // ...
}
```

Injected dependencies:

```typescript
interface RouterDependencies {
  metricsStore: MetricsStore;
  storeFactory: StoreFactory;
  requestContext: RequestContext;
  cacheStrategy: CacheStrategy;
  loaderExecutor: LoaderExecutor;
}

function createMatchPartial(deps: RouterDependencies) {
  return async function matchPartial(request, context, actionContext) {
    const { metricsStore, storeFactory, cacheStrategy } = deps;
    // ... now all deps are explicit and mockable
  };
}
```

---

## Proposed Module Structure

```
packages/rsc-router/src/
├── router.ts                    # Main exports, createRSCRouter
├── router/
│   ├── types.ts                 # All type definitions
│   ├── match/
│   │   ├── index.ts             # Re-exports
│   │   ├── match-full.ts        # Document/SSR matching
│   │   ├── match-partial.ts     # Navigation matching
│   │   ├── match-error.ts       # Error boundary matching
│   │   └── route-matcher.ts     # URL → Route logic
│   ├── resolve/
│   │   ├── index.ts
│   │   ├── pipeline.ts          # Resolution pipeline
│   │   ├── segment-resolver.ts  # Single segment resolution
│   │   ├── loader-resolver.ts   # Loader execution
│   │   └── parallel-resolver.ts # Parallel slot resolution
│   ├── revalidation/
│   │   ├── index.ts
│   │   ├── evaluator.ts         # Should revalidate logic
│   │   └── strategies.ts        # Revalidation strategies
│   ├── cache/
│   │   ├── index.ts
│   │   ├── cache-scope.ts       # Cache boundary logic
│   │   ├── lookup.ts            # Cache retrieval
│   │   └── store.ts             # Cache storage
│   ├── intercept/
│   │   ├── index.ts
│   │   ├── detector.ts          # Should intercept logic
│   │   └── resolver.ts          # Intercept resolution
│   ├── error/
│   │   ├── index.ts
│   │   ├── boundary-finder.ts   # Find nearest boundary
│   │   └── segment-factory.ts   # Create error segments
│   └── builder/
│       ├── index.ts
│       └── route-builder.ts     # Route registration API
```

---

## Migration Strategy

### Phase 1: Extract Pure Functions (Low Risk)
- Move type definitions to `router/types.ts`
- Extract `findMatch` to `router/match/route-matcher.ts`
- Extract error boundary finding to `router/error/`

### Phase 2: Extract Resolution Logic (Medium Risk)
- Create `SegmentResolver` class with visitor pattern
- Move revalidation evaluation to dedicated module
- Extract cache handling to `router/cache/`

### Phase 3: Refactor matchPartial (Higher Risk)
- Split into phases (match → plan → resolve → diff)
- Implement pipeline pattern
- Add comprehensive tests before refactoring

### Phase 4: Async Iterator Pipeline (Experimental)
- Implement streaming resolution
- Test with real-world scenarios
- Measure performance impact

---

## Testing Strategy

### Unit Tests (per module)
```typescript
describe('RouteMatch', () => {
  it('matches exact paths', () => {});
  it('extracts params from dynamic segments', () => {});
  it('handles optional params', () => {});
  it('detects route group changes', () => {});
});

describe('RevalidationEvaluator', () => {
  it('returns true when params change for route segments', () => {});
  it('executes custom revalidate functions', () => {});
  it('handles action context', () => {});
});

describe('CacheStrategy', () => {
  it('returns cached segments on hit', () => {});
  it('triggers background revalidation when stale', () => {});
  it('skips cache for actions', () => {});
});
```

### Integration Tests
```typescript
describe('matchPartial', () => {
  it('returns diff for same-group navigation', () => {});
  it('falls back to full render for cross-group navigation', () => {});
  it('handles intercept activation', () => {});
  it('respects revalidation rules', () => {});
  it('uses cache correctly', () => {});
});
```

---

## Performance Considerations

### Current Bottlenecks
1. **Sequential entry resolution**: Entries resolved one-by-one
2. **Revalidation evaluation**: Called per-segment
3. **Cache operations**: Blocking I/O

### Optimization Opportunities
1. **Parallel loader execution**: Already using `loaderPromises` map
2. **Batch revalidation**: Evaluate all at once, then resolve
3. **Streaming cache**: Don't wait for full cache write
4. **Early termination**: Stop resolving if navigation cancelled

### Async Iterator Benefits for Performance
```typescript
// Current: resolve all, then filter
const allSegments = await resolveAll(entries);
const toRender = allSegments.filter(s => s.component !== null);

// Async iterator: stream only what's needed
async function* resolveNeeded(entries, clientSegments) {
  for (const entry of entries) {
    if (needsResolution(entry, clientSegments)) {
      yield await resolveSegment(entry);
    }
    // Early exit if navigation cancelled
    if (signal.aborted) return;
  }
}
```

---

## Critical Analysis: Would Middleware Pattern Actually Help?

### The Honest Answer: Maybe Not

The middleware pattern is elegant in theory, but the router has characteristics that resist linearization:

### Problem 1: Fundamental Branching

The router isn't a linear pipeline - it's a **decision tree**:

```
                    matchPartial
                         │
                    ┌────┴────┐
                    │ Cache?  │
                    └────┬────┘
               ┌────────┴────────┐
               ▼                 ▼
           CACHE HIT         CACHE MISS
               │                 │
        ┌──────┴──────┐    ┌────┴────┐
        │ Has loaders?│    │Intercept?│
        └──────┬──────┘    └────┬────┘
           ... etc            ... etc
```

A middleware pipeline assumes linear flow. Our router has **at least 6 major branch points**:
1. Cache hit vs miss
2. Intercept vs normal
3. Action vs navigation
4. Stale (SWR) vs fresh
5. Client has segment vs doesn't
6. Error vs success

### Problem 2: The Promise/Await Dance

The router carefully controls **what resolves when**:

```typescript
// IMMEDIATELY AWAITED - blocks response
const cacheResult = await cacheScope.lookupRoute(...);
const manifest = await loadManifest(...);

// STAYS AS PROMISE - streams to client
segment.loaderDataPromise = Promise.all(loaderPromises);
segment.component = Promise.resolve(<Component />);

// BACKGROUND - doesn't block response
requestCtx.waitUntil(async () => {
  // SWR revalidation
  // Proactive caching
});

// PARALLEL - resolved concurrently
const [loaderResult, parallelResult] = await Promise.all([...]);
```

Middleware pattern would need to preserve all these semantics. A naive implementation would either:
- Await everything (slow, breaks streaming)
- Promise everything (breaks error handling)

### Problem 3: Shared Mutable State

Multiple parts of the code read/write shared state:

```typescript
// loaderPromises - written by loaders, read by handlers via ctx.use()
const loaderPromises = new Map<string, Promise<any>>();

// matchedIds - accumulated throughout resolution
const matchedIds: string[] = [];

// slots - built up as intercepts are found
const slots: Record<string, SlotState> = {};

// segments - collected, then filtered at end
const segments: ResolvedSegment[] = [];
```

Middleware works best with **immutable data flow**. Our router is inherently stateful.

### Problem 4: The Context Explosion

Look at what `resolveAllSegmentsWithRevalidation` needs:

```typescript
async function resolveAllSegmentsWithRevalidation(
  entries: EntryData[],              // Route manifest
  routeKey: string,                   // Current route
  params: Record<string, string>,     // URL params
  context: HandlerContext,            // Request context
  clientSegmentSet: Set<string>,      // What client has
  prevParams: Record<string, string>, // Previous params
  request: Request,                   // Raw request
  prevUrl: URL,                       // Previous URL
  nextUrl: URL,                       // Current URL
  loaderPromises: Map<...>,           // Shared loader state
  actionContext?: ActionContext,      // If action
  interceptResult?: InterceptResult,  // If intercepting
  localRouteName: string,             // For logging
  pathname: string                    // For errors
)
```

**14 parameters!** Each middleware would need access to most of these. We'd either:
- Pass a giant context object (same problem, different shape)
- Use closures (harder to test, implicit dependencies)

### Problem 5: Edge Cases Are the Feature

The "messy" parts of the code handle real requirements:

```typescript
// When leaving intercept, force route segment render
if (isSameRouteNavigation && manifestEntry.type === "route") {
  clientSegmentSet.delete(manifestEntry.shortCode);
}

// For actions: skip intercept if client doesn't have intercept segments
const skipInterceptForAction = isAction && !clientHasInterceptSegments;

// For cache hit with intercept, extract intercept segments but re-resolve loaders
if (interceptResult && cacheHit && isIntercept) {
  // ... 50 lines of specific handling
}
```

These aren't "complexity to refactor away" - they're **business logic**. Middleware wouldn't eliminate them, just relocate them.

---

## What Would Actually Help

### 1. Context Object (Reduce Parameter Passing)

```typescript
interface ResolutionContext {
  // Request info
  request: Request;
  pathname: string;
  url: URL;
  prevUrl: URL;

  // Route info
  matched: RouteMatch;
  entries: EntryData[];

  // Client state
  clientSegments: Set<string>;
  prevParams: Record<string, string>;

  // Shared state
  loaderPromises: Map<string, Promise<any>>;

  // Optional contexts
  actionContext?: ActionContext;
  interceptResult?: InterceptResult;
  cacheScope?: CacheScope;
  metricsStore?: MetricsStore;
}

// Functions become cleaner:
async function resolveSegment(
  entry: EntryData,
  ctx: ResolutionContext
): Promise<SegmentResult> {
  // Access ctx.clientSegments, ctx.prevParams, etc.
}
```

### 2. Extract Decision Functions (Pure Logic)

```typescript
// Pure functions - easy to test, easy to understand
function shouldRevalidateSegment(
  segment: ResolvedSegment,
  clientSegments: Set<string>,
  prevParams: Record<string, string>,
  currentParams: Record<string, string>,
  revalidateFns: RevalidateFn[]
): boolean {
  // All the revalidation logic in one place
}

function shouldActivateIntercept(
  matched: RouteMatch,
  prevMatch: RouteMatch | null,
  isAction: boolean,
  clientHasInterceptSegments: boolean
): boolean {
  // All intercept activation logic in one place
}

function selectCachePath(
  cacheResult: CacheResult | null,
  isAction: boolean,
  isIntercept: boolean
): 'hit' | 'miss' | 'skip' {
  // Cache decision logic
}
```

### 3. Explicit State Machine (For Tracing)

```typescript
type ResolutionPhase =
  | 'parse-request'
  | 'match-route'
  | 'check-intercept'
  | 'lookup-cache'
  | 'resolve-segments'
  | 'resolve-intercept'
  | 'filter-results'
  | 'store-cache'
  | 'complete';

function logPhaseTransition(from: ResolutionPhase, to: ResolutionPhase, data?: any) {
  console.log(`[Router] ${from} → ${to}`, data);
}

// In matchPartial:
logPhaseTransition('parse-request', 'match-route', { pathname });
const matched = findMatch(pathname);

logPhaseTransition('match-route', 'check-intercept', { routeKey: matched.routeKey });
const interceptResult = shouldActivateIntercept(...) ? findIntercept(...) : null;

// etc.
```

### 4. Split by Major Branch (Not by Concern)

Instead of middleware, split by the **major decision points**:

```typescript
async function matchPartial(request, context, actionContext) {
  const ctx = buildResolutionContext(request, context, actionContext);

  // Phase 1: Setup (always runs)
  const { matched, prevMatch, interceptResult } = await setupPhase(ctx);

  // Phase 2: Branch on cache
  const cacheResult = await lookupCache(ctx);

  if (cacheResult) {
    return await handleCacheHit(ctx, cacheResult, interceptResult);
  } else {
    return await handleCacheMiss(ctx, interceptResult);
  }
}

async function handleCacheHit(ctx, cacheResult, interceptResult) {
  // ~150 lines focused on cache hit path
}

async function handleCacheMiss(ctx, interceptResult) {
  // ~200 lines focused on cache miss path
}
```

This preserves the **branching nature** while making each branch comprehensible.

### 5. Keep Promise Semantics Explicit

Document and preserve the await/promise dance:

```typescript
interface SegmentResult {
  // Immediately available
  id: string;
  type: SegmentType;

  // May be promise (for streaming)
  component: ReactNode | Promise<ReactNode>;

  // Always promise (for suspense)
  loaderDataPromise?: Promise<LoaderData>;

  // Metadata (immediate)
  loading?: ReactNode;
  namespace?: string;
}
```

---

## Revised Assessment

| Approach | Readability | Maintainability | Risk | Recommendation |
|----------|-------------|-----------------|------|----------------|
| **Middleware Pipeline** | Maybe worse | Unclear | High | Skip |
| **Context Object** | Better | Better | Low | Do first |
| **Decision Functions** | Much better | Much better | Low | Do second |
| **State Machine Logging** | Better | Better | Low | Do third |
| **Branch Split** | Better | Better | Medium | Do fourth |

### The Middleware Trap

The middleware pattern is seductive because it promises:
- Separation of concerns
- Composability
- Testability

But for our router, it would likely:
- **Obscure** the branching logic that's core to the design
- **Complicate** the promise/await timing
- **Scatter** related code across multiple middlewares
- **Require** passing huge context through the chain

### What the Router Actually Needs

1. **Better organization** of the existing imperative code
2. **Pure decision functions** extracted for testing
3. **Context bundling** to reduce parameter explosion
4. **Clear documentation** of the promise semantics
5. **Tracing/logging** to understand request flow

The 770 lines of `matchPartial` won't become 77 lines. But they can become **770 well-organized lines** that are easier to follow, test, and modify.

---

## Concrete Refactoring Plan

### Phase 1: Low Risk (Do Now)
```
[x] Create ResolutionContext interface (router/types.ts)
[x] Extract shouldRevalidateSegment() - already exists in router/revalidation.ts
[x] Extract shouldLookupIntercept() pure function (router/intercept.ts)
[x] Extract applyCacheRevalidation() - cache-hit revalidation (router/cache-revalidation.ts)
```

### Phase 2: Medium Risk (After Tests)
```
[ ] Split matchPartial into setup/cacheHit/cacheMiss
[ ] Bundle parameters into context object
[ ] Extract cache lookup/store to separate functions
```

### Phase 3: Higher Risk (With Feature Flags)
```
[ ] Consider async generators for segment streaming only
[ ] Profile and optimize hot paths
[ ] Add comprehensive tracing
```

### What NOT to Do
```
[x] Don't convert to middleware pipeline
[x] Don't abstract away the branching
[x] Don't change promise/await semantics
[x] Don't lose the edge case handling
```

---

## Extracted Files (Progress)

| File | Purpose |
|------|---------|
| `router/types.ts` | ResolutionContext, RouteMatch, InterceptResult, ActionContext, SlotState, SegmentResolutionResult |
| `router/intercept.ts` | shouldLookupIntercept() - pure function for intercept decision |
| `router/cache-revalidation.ts` | applyCacheRevalidation() - applies revalidation to cached segments |
| `router/cache-handlers.ts` | handleCacheHit(), handleCacheMiss(), handleCacheHitIntercept() - cache path handlers |
| `router/resolution-context.ts` | buildResolutionContext(), getRevalidationParams(), getInterceptParams() |
| `router/segment-pipeline.ts` | Async generator middleware model prototype |
| `router/revalidation.ts` | evaluateRevalidation() - already well-extracted |

## Unit Tests

| File | Tests | Coverage |
|------|-------|----------|
| `router/__tests__/intercept.test.ts` | 15 | shouldLookupIntercept, clientHasInterceptSegments |
| `router/__tests__/cache-revalidation.test.ts` | 7 | applyCacheRevalidation |
| `router/__tests__/resolution-context.test.ts` | 12 | buildResolutionContext, getRevalidationParams, getInterceptParams |
| `router/__tests__/pattern-matching.test.ts` | 52 | findMatch, traverseBack (existing) |

---

## Async Generator Pipeline Model

The `segment-pipeline.ts` file demonstrates an alternative approach using async generators:

```typescript
// Compose middleware into a pipeline
const segmentPipeline = composePipeline(
  loggingMiddleware,
  createCachingMiddleware(lookupCache, storeCache),
  revalidationMiddleware,
  resolveSegmentsStage
);

// Use in matchPartial - segments stream as they're ready
for await (const segment of segmentPipeline(ctx)) {
  segments.push(segment);
}
```

**Benefits:**
- Streaming: segments yield as soon as ready
- Composable: middleware can be reordered/added easily
- Testable: each middleware tests independently

**Tradeoffs:**
- More indirection - harder to trace execution
- Generator semantics can be confusing
- May be overkill for current complexity

---

## Next Steps

1. [x] Integrate cache handlers into router.ts (medium risk)
2. [x] Bundle parameters into ResolutionContext usage
3. [ ] Create test coverage for matchPartial edge cases
4. [ ] Consider async generator model for streaming scenarios
5. [ ] Document promise semantics explicitly

---

## Recent Progress (2024-01)

### Completed: Cache Handlers Extraction

Extracted cache hit and miss logic from `matchPartial` into separate functions:
- `handleCacheHit(ctx, deps, cacheResult)` - handles cached segment revalidation + fresh loaders
- `handleCacheMiss(ctx, deps, interceptResult, slots)` - handles full segment resolution
- `handleCacheHitIntercept(ctx, deps, interceptResult, segments, slots)` - handles intercept on cache hit

The `CacheHandlerDeps` interface provides router closure functions to the handlers:
- `Store`, `getContext`, `buildEntryRevalidateMap`
- Resolution functions: `resolveLoadersOnlyWithRevalidation`, `resolveAllSegmentsWithRevalidation`
- Intercept functions: `resolveInterceptEntry`, `resolveInterceptLoadersOnly`

This reduces `matchPartial` complexity while keeping SWR/proactive caching logic inline (requires `waitUntil`).

### Completed: ResolutionContext Integration

Integrated `buildResolutionContext()` throughout `matchPartial`:
- Created `resolutionCtx` after entries collection (line ~3085)
- Updated all major function calls to use context values:
  - `applyCacheRevalidation()` - uses `resolutionCtx.*`
  - `resolveLoadersOnlyWithRevalidation()` - uses `resolutionCtx.*`
  - `resolveAllSegmentsWithRevalidation()` (cache miss) - uses `resolutionCtx.*`
  - `resolveInterceptEntry()` - uses `getInterceptParams(resolutionCtx)`
  - `resolveInterceptLoadersOnly()` - uses `getInterceptParams(resolutionCtx)`
- Background `waitUntil` callbacks capture values from `resolutionCtx` for safe async access
- Metrics logging and return values use `resolutionCtx.*`

**Test Results:** All 86 unit tests pass, all cache/revalidation/navigation e2e tests pass.
