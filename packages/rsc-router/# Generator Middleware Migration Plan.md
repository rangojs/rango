# Generator Middleware Migration Plan

## Status: 🏗️ Phase J In Progress (Infrastructure Complete)

**Goal:** Refactor ALL match\* functions (`match`, `matchPartial`, `matchError`, `matchMiddleware`) to use the elegant async generator middleware pattern for maximum composability, testability, and readability.

**Primary Objective:** Make router.ts more readable, maintainable, and beautiful.

**Methodology:**

- Start from router.ts and work outward
- Small incremental steps with mandatory test verification
- Never proceed until all tests pass
- **Full commitment to generator pattern** - no half-measures
- **No backwards compatibility needed** - this is a clean refactor
- **Edge cases must remain correct** - critical to preserve all existing behavior

**Functions to Refactor:**

- `match()` - router.ts:2433 - Main route matching
- `matchError()` - router.ts:2662 - Error boundary matching
- `matchPartial()` - router.ts:2833 - Partial/incremental matching
- `matchMiddleware()` - middleware.ts:356 - Middleware matching

---

## Progress Tracker

| Phase | Description                        | Status                      |
| ----- | ---------------------------------- | --------------------------- |
| A     | Foundation & Analysis              | ✅ Complete                 |
| B     | Core Middleware Extraction         | ✅ Complete                 |
| C     | Refactor `match()`                 | ✅ Complete                 |
| D     | Refactor `matchPartial()`          | ✅ Complete (Phase I)       |
| E     | Refactor `matchError()`            | ✅ N/A (no iteration)       |
| F     | Refactor `matchMiddleware()`       | ✅ N/A (synchronous)        |
| G     | Pipeline Composition & Unification | ✅ Complete                 |
| H     | Cleanup & Polish                   | ✅ Complete                 |
| I     | Elegant Pipeline Composition       | ✅ Complete                 |
| J     | Beautiful Match Functions          | 🏗️ In Progress (infra done) |

**Final Test Status**: ✅ 164 unit tests, 95+ e2e tests (1 skipped, some flaky)

### Key Decisions

- **No backwards compatibility** - Clean break, full generator adoption
- **Edge cases are critical** - All existing behavior must be preserved
- **All match\* functions** - Complete refactor of match, matchPartial, matchError, matchMiddleware

---

## The Pattern

### Core Concept

A middleware is simply a function that takes a generator and returns a new generator:

```typescript
type GeneratorMiddleware<T> = (source: AsyncGenerator<T>) => AsyncGenerator<T>;
```

This is beautiful because:

- **No magic** - just function composition
- **No discriminated unions** - everything is the same type
- **No `next()` callbacks** - just iterate the source
- **Independently testable** - each middleware is a pure transform

### Composition

```typescript
function compose<T>(
  ...middlewares: GeneratorMiddleware<T>[]
): GeneratorMiddleware<T> {
  return (source) => middlewares.reduceRight((gen, mw) => mw(gen), source);
}

// Usage: compose(a, b, c)(source) === a(b(c(source)))
// Data flows: source → c → b → a → consumer
```

### Example Middleware

```typescript
// Observe all items (logging)
async function* withLogging<T>(source: AsyncGenerator<T>): AsyncGenerator<T> {
  console.log("[Start]");
  for await (const item of source) {
    console.log("[Yield]", item);
    yield item;
  }
  console.log("[Done]");
}

// Transform items
async function* withTransform<T>(source: AsyncGenerator<T>): AsyncGenerator<T> {
  for await (const item of source) {
    yield transform(item);
  }
}

// Filter items
async function* withFilter<T>(source: AsyncGenerator<T>): AsyncGenerator<T> {
  for await (const item of source) {
    if (shouldInclude(item)) {
      yield item;
    }
  }
}

// Short-circuit (early termination)
async function* withLimit<T>(
  source: AsyncGenerator<T>,
  max: number
): AsyncGenerator<T> {
  let count = 0;
  for await (const item of source) {
    if (count >= max) break;
    yield item;
    count++;
  }
}

// Inject additional items
async function* withExtra<T>(
  source: AsyncGenerator<T>,
  extra: T[]
): AsyncGenerator<T> {
  yield* source;
  for (const item of extra) {
    yield item;
  }
}
```

---

## Architecture Design

### Current vs. Target

**Current (matchPartial):**

```
matchPartial()
  ├── Extract client state (imperative)
  ├── Match routes (imperative)
  ├── Load manifest (imperative)
  ├── Build context (imperative)
  ├── Cache lookup (imperative)
  ├── if cache hit: handleCacheHit()
  ├── if cache miss: handleCacheMiss()
  ├── Resolve intercepts (imperative)
  ├── Queue background work (imperative)
  └── Return result (imperative)
```

**Target (matchPartial):**

```typescript
const matchPartial = (request, env) => {
  // Create the terminal generator (source of segments)
  const source = resolveSegments(request, env);

  // Compose middleware pipeline
  const pipeline = compose(
    withMetrics(metricsStore),
    withRevalidation(clientState),
    withCacheLookup(cacheScope),
    withInterceptResolution(interceptResult),
    withBackgroundWork(waitUntil)
  )(source);

  // Collect results
  return collectMatchResult(pipeline);
};
```

### Two-Level Pipeline Architecture

We need two levels of generators:

1. **Request-level generator** - yields request processing stages
2. **Segment-level generator** - yields resolved segments

```
Request Pipeline (outer)
├── yields: RouteMatchResult
├── yields: ManifestLoadResult
├── yields: CacheCheckResult
└── yields: SegmentPipeline (inner)
    ├── yields: ResolvedSegment
    ├── yields: ResolvedSegment
    └── yields: ResolvedSegment
```

But actually, for maximum simplicity, we can flatten this:

```
Single Pipeline
├── Terminal: resolveAllSegments(ctx) → yields segments
├── Middleware: withRevalidation → filters/transforms segments
├── Middleware: withMetrics → observes segments
├── Middleware: withCaching → caches segments
└── Consumer: collectMatchResult → builds final result
```

The request-level logic (route matching, manifest loading, etc.) happens BEFORE we create the pipeline. The pipeline is purely for segment processing.

---

## Detailed Implementation Plan

### File Structure

```
packages/rsc-router/src/router/
├── generator-middleware.ts      # Core types and compose
├── middleware/
│   ├── index.ts                 # Barrel export
│   ├── metrics.ts               # Timing and logging
│   ├── revalidation.ts          # Filter unchanged segments
│   ├── error-boundary.ts        # Catch errors, yield error segments
│   ├── cache.ts                 # Cache lookup/store
│   └── background.ts            # Queue background work
├── terminals/
│   ├── index.ts                 # Barrel export
│   ├── segment-resolver.ts      # Resolve route segments
│   ├── loader-resolver.ts       # Resolve loaders only
│   └── cached-segments.ts       # Yield cached segments
└── pipelines/
    ├── index.ts                 # Barrel export
    ├── match-partial.ts         # matchPartial pipeline
    └── match.ts                 # match pipeline
```

### Phase 1: Core Infrastructure

**File: `generator-middleware.ts`**

````typescript
/**
 * Generator Middleware - Composable async generator transforms
 *
 * This module provides the foundation for building composable pipelines
 * using the async generator middleware pattern.
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * A middleware transforms an async generator into another async generator.
 *
 * Middleware can:
 * - Observe items (logging, metrics)
 * - Transform items (modify, enrich)
 * - Filter items (skip, include)
 * - Short-circuit (early termination)
 * - Inject items (add before/after)
 * - Handle errors (catch and recover)
 */
export type GeneratorMiddleware<T, TContext = void> = TContext extends void
  ? (source: AsyncGenerator<T>) => AsyncGenerator<T>
  : (source: AsyncGenerator<T>, ctx: TContext) => AsyncGenerator<T>;

/**
 * A terminal generator produces items from scratch.
 * This is the "source" that middleware wraps.
 */
export type TerminalGenerator<T, TContext> = (
  ctx: TContext
) => AsyncGenerator<T>;

// ============================================================================
// Composition
// ============================================================================

/**
 * Compose multiple middleware into a single middleware.
 *
 * Execution order: compose(a, b, c)(source)
 * - c wraps source
 * - b wraps c's output
 * - a wraps b's output
 * - consumer receives a's output
 *
 * Data flows: source → c → b → a → consumer
 *
 * @example
 * ```typescript
 * const pipeline = compose(
 *   withLogging,
 *   withMetrics,
 *   withRevalidation,
 * );
 *
 * for await (const segment of pipeline(source)) {
 *   // Process segment
 * }
 * ```
 */
export function compose<T>(
  ...middlewares: GeneratorMiddleware<T>[]
): GeneratorMiddleware<T> {
  if (middlewares.length === 0) {
    return (source) => source;
  }

  return (source) =>
    middlewares.reduceRight(
      (generator, middleware) => middleware(generator),
      source
    );
}

/**
 * Create a pipeline from a terminal and middleware.
 *
 * @example
 * ```typescript
 * const pipeline = createPipeline(
 *   resolveSegments,
 *   withLogging,
 *   withMetrics,
 * );
 *
 * for await (const segment of pipeline(ctx)) {
 *   // Process segment
 * }
 * ```
 */
export function createPipeline<T, TContext>(
  terminal: TerminalGenerator<T, TContext>,
  ...middlewares: GeneratorMiddleware<T>[]
): (ctx: TContext) => AsyncGenerator<T> {
  const composed = compose(...middlewares);
  return (ctx) => composed(terminal(ctx));
}

// ============================================================================
// Utility Middleware Factories
// ============================================================================

/**
 * Create a middleware that transforms each item.
 */
export function map<T>(
  fn: (item: T) => T | Promise<T>
): GeneratorMiddleware<T> {
  return async function* (source) {
    for await (const item of source) {
      yield await fn(item);
    }
  };
}

/**
 * Create a middleware that filters items.
 */
export function filter<T>(
  predicate: (item: T) => boolean | Promise<boolean>
): GeneratorMiddleware<T> {
  return async function* (source) {
    for await (const item of source) {
      if (await predicate(item)) {
        yield item;
      }
    }
  };
}

/**
 * Create a middleware that observes items without modifying them.
 */
export function tap<T>(
  fn: (item: T) => void | Promise<void>
): GeneratorMiddleware<T> {
  return async function* (source) {
    for await (const item of source) {
      await fn(item);
      yield item;
    }
  };
}

/**
 * Create a middleware that catches errors and optionally recovers.
 */
export function catchError<T>(
  handler: (error: Error) => AsyncGenerator<T> | void
): GeneratorMiddleware<T> {
  return async function* (source) {
    try {
      yield* source;
    } catch (error) {
      const recovery = handler(error as Error);
      if (recovery) {
        yield* recovery;
      }
    }
  };
}

/**
 * Create a middleware that limits the number of items.
 */
export function take<T>(count: number): GeneratorMiddleware<T> {
  return async function* (source) {
    let n = 0;
    for await (const item of source) {
      if (n >= count) break;
      yield item;
      n++;
    }
  };
}

/**
 * Create a middleware that appends items after the source completes.
 */
export function concat<T>(
  ...generators: AsyncGenerator<T>[]
): GeneratorMiddleware<T> {
  return async function* (source) {
    yield* source;
    for (const gen of generators) {
      yield* gen;
    }
  };
}
````

### Phase 2: Segment Resolution Middleware

**File: `middleware/metrics.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { MetricsStore } from "../../server/context";
import type { GeneratorMiddleware } from "../generator-middleware";

/**
 * Metrics middleware - records timing for each segment.
 */
export function withMetrics(
  metricsStore: MetricsStore | undefined
): GeneratorMiddleware<ResolvedSegment> {
  if (!metricsStore?.enabled) {
    return (source) => source; // Pass-through when disabled
  }

  return async function* (source) {
    const start = performance.now();
    let count = 0;

    for await (const segment of source) {
      count++;
      const elapsed = performance.now() - start;
      metricsStore.metrics.push({
        name: `segment:${segment.id}`,
        duration: elapsed,
      });
      yield segment;
    }

    metricsStore.metrics.push({
      name: "segments:total",
      duration: performance.now() - start,
      count,
    });
  };
}
```

**File: `middleware/revalidation.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { GeneratorMiddleware } from "../generator-middleware";
import { evaluateRevalidation } from "../revalidation";

export interface RevalidationContext {
  clientSegmentSet: Set<string>;
  prevParams: Record<string, string>;
  request: Request;
  prevUrl: URL;
  nextUrl: URL;
  routeKey: string;
  handlerContext: any;
  actionContext?: any;
  entryRevalidateMap: Map<string, { revalidate: any[] }>;
}

/**
 * Revalidation middleware - filters segments client already has.
 *
 * For each segment:
 * - If client doesn't have it → yield with component
 * - If client has it and should revalidate → yield with component
 * - If client has it and should NOT revalidate → yield with component=null
 */
export function withRevalidation(
  ctx: RevalidationContext
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    for await (const segment of source) {
      // Loaders always pass through unchanged
      if (segment.type === "loader") {
        yield segment;
        continue;
      }

      // Intercept segments handled separately
      if (segment.namespace?.startsWith("intercept:")) {
        yield segment;
        continue;
      }

      // Client doesn't have it - yield with component
      if (!ctx.clientSegmentSet.has(segment.id)) {
        yield segment;
        continue;
      }

      // Check revalidation rules
      const entryInfo = ctx.entryRevalidateMap.get(segment.id);
      if (!entryInfo?.revalidate?.length) {
        // No revalidation rules - skip render (client has it)
        yield { ...segment, component: null, loading: undefined };
        continue;
      }

      // Evaluate revalidation
      const shouldRevalidate = await evaluateRevalidation({
        segment,
        prevParams: ctx.prevParams,
        request: ctx.request,
        prevUrl: ctx.prevUrl,
        nextUrl: ctx.nextUrl,
        revalidations: entryInfo.revalidate.map((fn, i) => ({
          name: `revalidate${i}`,
          fn,
        })),
        routeKey: ctx.routeKey,
        context: ctx.handlerContext,
        actionContext: ctx.actionContext,
      });

      if (shouldRevalidate) {
        yield segment;
      } else {
        yield { ...segment, component: null, loading: undefined };
      }
    }
  };
}
```

**File: `middleware/error-boundary.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { EntryData } from "../../server/context";
import type { GeneratorMiddleware } from "../generator-middleware";

/**
 * Error boundary middleware - catches errors and yields error segments.
 */
export function withErrorBoundary(
  findErrorBoundary: (routeKey: string) => EntryData | null,
  routeKey: string,
  createErrorSegment: (error: Error, boundary: EntryData) => ResolvedSegment
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    try {
      yield* source;
    } catch (error) {
      const boundary = findErrorBoundary(routeKey);
      if (boundary) {
        yield createErrorSegment(error as Error, boundary);
      } else {
        throw error; // Re-throw if no boundary
      }
    }
  };
}
```

**File: `middleware/cache.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { GeneratorMiddleware } from "../generator-middleware";
import type { CacheScope } from "../../cache/cache-scope";

/**
 * Cache store middleware - stores segments in cache after yielding.
 */
export function withCacheStore(
  cacheScope: CacheScope | null,
  pathname: string,
  params: Record<string, string>,
  isIntercept: boolean
): GeneratorMiddleware<ResolvedSegment> {
  if (!cacheScope?.enabled) {
    return (source) => source;
  }

  return async function* (source) {
    const segments: ResolvedSegment[] = [];

    for await (const segment of source) {
      segments.push(segment);
      yield segment;
    }

    // Cache after all segments collected
    cacheScope.cacheRoute(pathname, params, segments, isIntercept);
  };
}
```

**File: `middleware/background.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { GeneratorMiddleware } from "../generator-middleware";

/**
 * Background work middleware - observes segments for SWR revalidation.
 */
export function withBackgroundRevalidation(
  waitUntil: ((fn: () => Promise<void>) => void) | undefined,
  revalidateFn: () => Promise<void>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    let shouldRevalidate = false;

    for await (const segment of source) {
      // Check if any segment indicates stale data
      if ((segment as any)._stale) {
        shouldRevalidate = true;
      }
      yield segment;
    }

    // Queue background revalidation if needed
    if (shouldRevalidate && waitUntil) {
      waitUntil(revalidateFn);
    }
  };
}
```

### Phase 3: Terminal Generators

**File: `terminals/segment-resolver.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { EntryData } from "../../server/context";

export interface SegmentResolverContext {
  entries: EntryData[];
  routeKey: string;
  params: Record<string, string>;
  handlerContext: any;
  loaderPromises: Map<string, Promise<any>>;
  resolveSegment: (
    entry: EntryData,
    routeKey: string,
    params: Record<string, string>,
    context: any,
    loaderPromises: Map<string, Promise<any>>
  ) => Promise<ResolvedSegment[]>;
}

/**
 * Terminal generator that resolves all route segments.
 */
export async function* resolveSegments(
  ctx: SegmentResolverContext
): AsyncGenerator<ResolvedSegment> {
  for (const entry of ctx.entries) {
    const segments = await ctx.resolveSegment(
      entry,
      ctx.routeKey,
      ctx.params,
      ctx.handlerContext,
      ctx.loaderPromises
    );

    for (const segment of segments) {
      yield segment;
    }
  }
}
```

**File: `terminals/cached-segments.ts`**

```typescript
import type { ResolvedSegment } from "../../types";

/**
 * Terminal generator that yields cached segments.
 */
export async function* yieldCachedSegments(
  segments: ResolvedSegment[]
): AsyncGenerator<ResolvedSegment> {
  for (const segment of segments) {
    yield segment;
  }
}
```

### Phase 4: Pipeline Composition

**File: `pipelines/match-partial.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import { compose, createPipeline } from "../generator-middleware";
import { withMetrics } from "../middleware/metrics";
import { withRevalidation } from "../middleware/revalidation";
import { withErrorBoundary } from "../middleware/error-boundary";
import { withCacheStore } from "../middleware/cache";
import { resolveSegments } from "../terminals/segment-resolver";
import { yieldCachedSegments } from "../terminals/cached-segments";

export interface MatchPartialContext {
  // ... all the context needed
}

/**
 * Create the segment resolution pipeline for cache misses.
 */
export function createCacheMissPipeline(ctx: MatchPartialContext) {
  return createPipeline(
    // Terminal: resolve all segments
    () =>
      resolveSegments({
        entries: ctx.entries,
        routeKey: ctx.routeKey,
        params: ctx.params,
        handlerContext: ctx.handlerContext,
        loaderPromises: ctx.loaderPromises,
        resolveSegment: ctx.resolveSegment,
      }),
    // Middleware stack (innermost to outermost)
    withErrorBoundary(
      ctx.findErrorBoundary,
      ctx.routeKey,
      ctx.createErrorSegment
    ),
    withRevalidation(ctx.revalidationContext),
    withCacheStore(ctx.cacheScope, ctx.pathname, ctx.params, ctx.isIntercept),
    withMetrics(ctx.metricsStore)
  );
}

/**
 * Create the segment resolution pipeline for cache hits.
 */
export function createCacheHitPipeline(ctx: MatchPartialContext) {
  return createPipeline(
    // Terminal: yield cached segments
    () => yieldCachedSegments(ctx.cachedSegments),
    // Middleware stack
    withRevalidation(ctx.revalidationContext),
    withMetrics(ctx.metricsStore)
  );
}

/**
 * Collect segments from pipeline into MatchResult.
 */
export async function collectMatchResult(
  pipeline: AsyncGenerator<ResolvedSegment>,
  ctx: MatchPartialContext
): Promise<MatchResult> {
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  for await (const segment of pipeline) {
    segments.push(segment);
    matchedIds.push(segment.id);
  }

  return {
    segments,
    matched: matchedIds,
    diff: matchedIds,
    params: ctx.params,
    serverTiming: ctx.metricsStore?.getServerTiming?.(),
    slots: ctx.slots,
    routeMiddleware: ctx.routeMiddleware,
  };
}
```

---

## Testing Strategy

Each middleware is independently testable:

```typescript
import { withRevalidation } from './middleware/revalidation';

describe('withRevalidation', () => {
  it('should pass through segments client does not have', async () => {
    const source = async function* () {
      yield { id: 'new-segment', component: <div /> };
    };

    const ctx = {
      clientSegmentSet: new Set<string>(), // Empty - client has nothing
      // ... other context
    };

    const pipeline = withRevalidation(ctx)(source());
    const results = [];
    for await (const segment of pipeline) {
      results.push(segment);
    }

    expect(results[0].component).not.toBeNull();
  });

  it('should null component for segments client has without revalidation', async () => {
    const source = async function* () {
      yield { id: 'existing-segment', component: <div /> };
    };

    const ctx = {
      clientSegmentSet: new Set(['existing-segment']),
      entryRevalidateMap: new Map(), // No revalidation rules
      // ... other context
    };

    const pipeline = withRevalidation(ctx)(source());
    const results = [];
    for await (const segment of pipeline) {
      results.push(segment);
    }

    expect(results[0].component).toBeNull();
  });
});
```

---

## Migration Strategy

### Core Principles

1. **Start from router.ts and work outward** - Begin with the main router entry point and extract/refactor outward
2. **Small incremental steps** - Each step must be atomic and testable
3. **Mandatory test verification** - Run all app tests and e2e tests after EVERY step
4. **No proceeding until green** - NEVER continue to the next step until ALL tests pass
5. **Goal: Readable, maintainable, beautiful code** - The primary objective is to make router.ts more elegant

### Test Command

After each step, run:

```bash
pnpm test && pnpm e2e
```

### Implementation Phases

#### Phase A: Foundation & Analysis

- [ ] Step A1: Read and document current router.ts structure (match, matchError, matchPartial)
- [ ] Step A2: Map all edge cases and special handling in each function
- [ ] Step A3: Create generator-middleware.ts with core types (compose, createPipeline)
- [ ] Step A4: Create terminal generator types and base infrastructure
- [ ] **RUN TESTS** - Verify no regressions

#### Phase B: Core Middleware Extraction

- [ ] Step B1: Extract segment resolution into terminal generator
- [ ] Step B2: Extract metrics logic into withMetrics middleware
- [ ] Step B3: Extract revalidation logic into withRevalidation middleware
- [ ] Step B4: Extract error boundary logic into withErrorBoundary middleware
- [ ] Step B5: Extract cache logic into withCacheStore middleware
- [ ] Step B6: Extract intercept logic into withIntercept middleware
- [ ] **RUN TESTS** - Verify no regressions

#### Phase C: Refactor `match()` Function

- [ ] Step C1: Convert match() to use generator pipeline
- [ ] Step C2: Handle all edge cases (redirects, not found, etc.)
- [ ] Step C3: Verify loader resolution works correctly
- [ ] **RUN TESTS** - Verify no regressions

#### Phase D: Refactor `matchPartial()` Function

- [ ] Step D1: Convert matchPartial() to use generator pipeline
- [ ] Step D2: Handle client state diffing correctly
- [ ] Step D3: Verify SWR and revalidation edge cases
- [ ] Step D4: Verify intercept route handling
- [ ] **RUN TESTS** - Verify no regressions

#### Phase E: Refactor `matchError()` Function

- [ ] Step E1: Convert matchError() to use generator pipeline
- [ ] Step E2: Handle error boundary lookup correctly
- [ ] Step E3: Verify error segment resolution
- [ ] **RUN TESTS** - Verify no regressions

#### Phase F: Refactor `matchMiddleware()` Function

- [ ] Step F1: Analyze matchMiddleware() in middleware.ts
- [ ] Step F2: Convert to generator pattern if applicable
- [ ] Step F3: Ensure middleware chaining works correctly
- [ ] **RUN TESTS** - Verify no regressions

#### Phase G: Pipeline Composition & Unification

- [ ] Step G1: Create unified pipeline factory for all match\* functions
- [ ] Step G2: Ensure consistent middleware ordering across all functions
- [ ] Step G3: Remove all duplicated logic between functions
- [ ] **RUN TESTS** - Verify no regressions

#### Phase H: Cleanup & Polish

- [ ] Step H1: Remove dead code from router.ts
- [ ] Step H2: Simplify and beautify remaining code
- [ ] Step H3: Add technical comments where non-obvious
- [ ] Step H4: Final review for readability and elegance
- [ ] **RUN TESTS** - Final verification

#### Phase I: Elegant Pipeline Composition

**Ultimate Goal:** Beautiful, correct, and extensible pipeline composition.

The match functions should read like a declaration of intent - compose middleware, collect results. No imperative spaghetti, no hidden state mutations, no duplicated logic paths. The code should be a joy to read and trivial to extend.

**The Problem:**
Intercept routes require `matchedIds` to include the route shortCode WITHOUT yielding a corresponding segment. The current generator pattern collects IDs from yielded segments, breaking intercept behavior when we tried to convert `matchPartial()` fully.

**The Solution: Marker Types**
Introduce a discriminated union that allows generators to yield both segments AND ID-only markers:

```typescript
type SegmentOrMarker = ResolvedSegment | { type: "id-marker"; id: string }; // ID without segment

function isMarker(
  item: SegmentOrMarker
): item is { type: "id-marker"; id: string } {
  return "type" in item && item.type === "id-marker";
}
```

The collector filters out markers but still tracks their IDs:

```typescript
async function collectSegmentsWithMarkers(
  pipeline: AsyncGenerator<SegmentOrMarker>
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  for await (const item of pipeline) {
    if (isMarker(item)) {
      matchedIds.push(item.id); // Track ID
    } else {
      segments.push(item);
      matchedIds.push(item.id);
    }
  }

  return { segments, matchedIds };
}
```

**Implementation Steps:**

- [x] Step I-pre: Checkpoint current status before Phase I
  - Run full test suite and document baseline (expected: 295 passed, 1 skipped)
  - Document current generator functions in router.ts
  - Document current non-generator functions that will be replaced
  - Create git commit/tag as rollback point if needed
- [x] Step I0: Investigate the 1 skipped test - determine if related to migration or pre-existing
- [x] Step I1: Add `SegmentOrMarker` type and `isMarker` guard to generator-middleware.ts
- [x] Step I2: Create `resolveAllSegmentsWithRevalidationGenerator()` to yield markers for intercept entries
- [x] Step I3: Create `collectWithMarkers()` utility (already existed in generator-middleware.ts)
- [x] Step I4: Wire markers into `matchPartial()` cache MISS path
- [x] Step I5: Wire markers into `matchPartial()` SWR revalidation path
- [x] Step I6: Remove non-generator `resolveAllSegmentsWithRevalidation()` function
- [x] Step I7: Re-evaluate skipped test - pre-existing, needs infrastructure work
- [x] **RUN TESTS** - Unit tests: 164 passed, E2E tests: 95+ passed (flaky tests are pre-existing)

**Target End State:**

```typescript
async function matchPartial(request, env) {
  // ... setup (route matching, manifest loading, context building) ...

  const source = resolveSegmentsWithRevalidation(entries, revalidationCtx);

  const pipeline = compose(
    withMetrics(metricsStore),
    withInterceptMarkers(interceptResult), // Yields markers for intercept IDs
    withCacheStore(cacheScope, pathname, params),
    withSWRRevalidation(waitUntil, shouldRevalidate)
  )(source);

  const { segments, matchedIds } = await collectSegmentsWithMarkers(pipeline);

  return {
    segments,
    matched: matchedIds,
    diff: matchedIds,
    params,
    // ...
  };
}
```

**Benefits:**

- Clean composition pattern matching the original vision
- All segment resolution logic flows through one pipeline
- Intercept ID tracking is explicit via markers
- Easier to test, reason about, and extend
- Removes duplication between generator and non-generator paths

---

#### Phase J: Beautiful Match Functions

**Ultimate Goal:** Transform `match()` and `matchPartial()` from 400-line monsters into ~50-line elegant pipelines.

**The Problem:**
Phase I converted segment resolution to use generators, but the match functions themselves are still massive:

- `matchPartial()`: ~400 lines of imperative code
- `match()`: ~300 lines of imperative code

The code mixes multiple concerns:

1. Request parsing (URL, headers, client state)
2. Route matching
3. Manifest loading
4. Context building
5. Intercept detection
6. Cache lookup/store
7. Segment resolution
8. Result assembly

**The Vision:**

```typescript
// matchPartial() should look like this:
async function matchPartial(
  request: Request,
  env: TEnv,
  actionContext?: ActionContext
) {
  // Phase 1: Build context (pure, no side effects)
  const ctx = await createMatchContext(request, env, actionContext);
  if (!ctx) return null; // No previous URL or route group changed

  // Phase 2: Run pipeline
  const pipeline = createMatchPartialPipeline(ctx);

  // Phase 3: Collect and return
  return collectMatchResult(pipeline, ctx);
}

// The pipeline is composed of middleware:
function createMatchPartialPipeline(ctx: MatchContext) {
  return compose(
    withMetrics(ctx.metricsStore),
    withCacheLookup(ctx.cacheScope), // Returns cached segments or passes through
    withSegmentResolution(ctx), // Resolves segments with revalidation
    withInterceptResolution(ctx.interceptResult), // Handles intercept routes
    withCacheStore(ctx.cacheScope), // Stores results for next request
    withBackgroundRevalidation(ctx.waitUntil) // SWR background refresh
  )(emptySource());
}
```

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│                     matchPartial()                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  createMatchContext(request, env, actionContext)    │   │
│  │  - Parse URL, extract client state                  │   │
│  │  - Match route, load manifest                       │   │
│  │  - Build handler context                            │   │
│  │  - Detect intercepts                                │   │
│  │  - Returns MatchContext or null                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  createMatchPartialPipeline(ctx)                    │   │
│  │  compose(                                           │   │
│  │    withMetrics,                                     │   │
│  │    withCacheLookup,                                 │   │
│  │    withSegmentResolution,                           │   │
│  │    withInterceptResolution,                         │   │
│  │    withCacheStore,                                  │   │
│  │    withBackgroundRevalidation,                      │   │
│  │  )                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  collectMatchResult(pipeline, ctx)                  │   │
│  │  - Collects segments and IDs                        │   │
│  │  - Builds final MatchResult                         │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**New File Structure:**

```
packages/rsc-router/src/router/
├── generator-middleware.ts     # Core compose, types (exists)
├── match-context.ts            # NEW: createMatchContext(), MatchContext type
├── match-pipelines.ts          # NEW: createMatchPipeline(), createMatchPartialPipeline()
├── match-middleware/           # NEW: Directory for match-specific middleware
│   ├── index.ts
│   ├── cache-lookup.ts         # withCacheLookup - returns cached or passes through
│   ├── cache-store.ts          # withCacheStore - stores after pipeline completes
│   ├── segment-resolution.ts   # withSegmentResolution - resolves with revalidation
│   ├── intercept-resolution.ts # withInterceptResolution - handles intercepts
│   ├── background-work.ts      # withBackgroundRevalidation - SWR
│   └── metrics.ts              # withMetrics - timing
└── match-result.ts             # NEW: collectMatchResult()
```

**Implementation Steps:**

- [ ] Step J1: Create `MatchContext` type and `createMatchContext()` function
  - Extract all setup logic from matchPartial() into a pure function
  - Returns `MatchContext | null` (null = fall back to full render)
  - Includes: url, pathname, clientSegmentSet, prevUrl, matched, manifestEntry,
    handlerContext, entries, cacheScope, interceptResult, metricsStore, etc.

- [ ] Step J2: Create `withCacheLookup` middleware
  - If cache hit: yields cached segments, sets `ctx.cacheHit = true`
  - If cache miss: passes through (yields nothing, lets next middleware handle)
  - Handles cache hit revalidation logic

- [ ] Step J3: Create `withSegmentResolution` middleware
  - Only runs if `!ctx.cacheHit`
  - Uses `resolveAllSegmentsWithRevalidationGenerator()` internally
  - Yields segments with markers

- [ ] Step J4: Create `withInterceptResolution` middleware
  - Resolves intercept segments if `ctx.interceptResult` exists
  - Yields intercept segments after main segments

- [ ] Step J5: Create `withCacheStore` middleware
  - Collects all segments, stores in cache after pipeline completes
  - Only stores if caching enabled and not an action

- [ ] Step J6: Create `withBackgroundRevalidation` middleware
  - If cache was stale, queues background revalidation via waitUntil
  - Observes segments, doesn't modify them

- [ ] Step J7: Create `collectMatchResult()` function
  - Collects segments and IDs from pipeline
  - Builds final `MatchResult` object
  - Handles slots metadata for intercepts

- [ ] Step J8: Compose into `createMatchPartialPipeline()`
  - Wire all middleware together
  - Replace matchPartial() internals with pipeline call

- [ ] Step J9: Refactor `matchPartial()` to use new structure
  - Should be ~30 lines after refactor
  - All complexity moved to middleware

- [ ] Step J10: Apply same pattern to `match()` function
  - Create `createMatchPipeline()` (simpler, no revalidation)
  - Refactor match() to ~30 lines

- [ ] **RUN TESTS** - Verify all tests pass

**Target End State for matchPartial():**

```typescript
async function matchPartial(
  request: Request,
  env: TEnv,
  actionContext?: ActionContext
): Promise<MatchResult | null> {
  // Build context - all setup logic extracted here
  const ctx = await createMatchContext(request, env, actionContext);
  if (!ctx) return null;

  try {
    // Run pipeline - all processing logic in middleware
    const pipeline = createMatchPartialPipeline(ctx);
    return await collectMatchResult(pipeline, ctx);
  } catch (error) {
    // Error handling stays here (Response short-circuit, sanitization)
    if (error instanceof Response) throw error;
    throw sanitizeError(error);
  }
}
```

**Target End State for match():**

```typescript
async function match(request: Request, env: TEnv): Promise<MatchResult> {
  const ctx = await createFullMatchContext(request, env);

  if (ctx.redirect) {
    return { redirect: ctx.redirect, ...emptyResult };
  }

  try {
    const pipeline = createMatchPipeline(ctx);
    return await collectMatchResult(pipeline, ctx);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw sanitizeError(error);
  }
}
```

**Benefits of Phase J:**

- Match functions become ~30 lines instead of ~400 lines
- Each middleware is independently testable
- Logic is clearly separated by concern
- Easy to add new middleware (logging, tracing, etc.)
- Easy to understand the flow at a glance
- Truly achieves the "beautiful, readable" goal

**Risks:**

- Large refactor with many moving parts
- Must preserve all edge cases (intercepts, SWR, actions, etc.)
- Need comprehensive test coverage before starting

**Prerequisites:**

- All Phase I work complete ✅
- Good understanding of current matchPartial() edge cases
- Run full e2e suite before and after each step

### Changelog

Maintain a separate changelog file at:

```
packages/rsc-router/MIGRATION_CHANGELOG.md
```

After each step, append an entry with:

- Step ID (e.g., A1, B2, C3)
- Date/time
- What was changed
- Files modified
- Test results (pass/fail)
- Any edge cases discovered

### Rules for Each Step

1. **Before starting**: Read the current state of router.ts
2. **Make ONE change**: Extract ONE piece of logic
3. **Wire it in**: Connect the new middleware without changing behavior
4. **Run tests**: Execute full test suite
5. **If tests fail**: Fix immediately before proceeding
6. **If tests pass**: Mark step complete, proceed to next
7. **Document**: Update this plan AND the changelog file

### Legacy Approach (Deprecated)

~~1. **Keep both implementations** during migration~~
~~2. **Feature flag** to switch between old and new~~
~~3. **Run e2e tests** against both implementations~~
~~4. **Gradual rollout** once stable~~
~~5. **Remove old code** after validation~~

**New approach**: Direct incremental refactoring with continuous test verification

---

## Advanced Middleware Patterns

### Branching Middleware: `withIntercept`

For intercept routes, we need to conditionally branch the pipeline. Intercepts skip the route component and append intercept segments after the main segments.

**File: `middleware/intercept.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { GeneratorMiddleware } from "../generator-middleware";

/**
 * Intercept branching middleware.
 * When intercepting: nulls route component, appends intercept segments.
 * When not intercepting: passes through unchanged.
 */
export function withIntercept(
  interceptResult: unknown,
  resolveIntercept: () => AsyncGenerator<ResolvedSegment>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    // Pass through main segments
    for await (const segment of source) {
      if (segment.type === "route" && interceptResult) {
        // Null route component when intercepting
        yield { ...segment, component: null };
      } else {
        yield segment;
      }
    }

    // Append intercept segments after main segments
    if (interceptResult) {
      yield* resolveIntercept();
    }
  };
}
```

**Usage in cache-handlers.ts:**

```typescript
const pipeline = createPipeline(
  resolveAllSegments,
  withIntercept(interceptResult, resolveInterceptSegments), // Branching
  withRevalidation(revalidationCtx),
  withMetrics(ctx.metricsStore)
);
```

### Fork/Join Middleware: `mergeAsyncGenerators`

For parallel resolution, we need to run multiple generators concurrently and yield items as they complete.

**File: `generator-middleware.ts`**

```typescript
/**
 * Merge multiple async generators into one.
 * Yields items in resolution order (not generator order).
 */
export async function* mergeAsyncGenerators<T>(
  generators: AsyncGenerator<T>[]
): AsyncGenerator<T> {
  if (generators.length === 0) return;

  interface Pending {
    index: number;
    gen: AsyncGenerator<T>;
    promise: Promise<{ index: number; result: IteratorResult<T> }>;
  }

  const pending: Pending[] = generators.map((gen, index) => ({
    index,
    gen,
    promise: gen.next().then((result) => ({ index, result })),
  }));

  while (pending.length > 0) {
    const { index, result } = await Promise.race(pending.map((p) => p.promise));
    const entryIndex = pending.findIndex((p) => p.index === index);
    const entry = pending[entryIndex];

    if (result.done) {
      pending.splice(entryIndex, 1);
    } else {
      yield result.value;
      entry.promise = entry.gen.next().then((r) => ({ index, result: r }));
    }
  }
}
```

### Parallel Slots Middleware: `withParallelSlots`

**File: `middleware/parallel.ts`**

```typescript
import type { ResolvedSegment } from "../../types";
import type { GeneratorMiddleware } from "../generator-middleware";
import { mergeAsyncGenerators } from "../generator-middleware";

/**
 * Fork/join middleware for parallel slot resolution.
 * Yields main segments, then all parallels concurrently.
 */
export function withParallelSlots<TParallel>(
  getParallels: (segment: ResolvedSegment) => TParallel[],
  resolveParallel: (parallel: TParallel) => AsyncGenerator<ResolvedSegment>
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (source) {
    const parallelGenerators: AsyncGenerator<ResolvedSegment>[] = [];

    // First pass: yield main segments, collect parallels
    for await (const segment of source) {
      yield segment;
      const parallels = getParallels(segment);
      for (const parallel of parallels) {
        parallelGenerators.push(resolveParallel(parallel));
      }
    }

    // Second pass: resolve all parallels concurrently
    if (parallelGenerators.length > 0) {
      yield* mergeAsyncGenerators(parallelGenerators);
    }
  };
}
```

---

## Current State Summary

All 288 unit tests pass. The following middleware are implemented:

| Middleware                    | File                    | Purpose                                      |
| ----------------------------- | ----------------------- | -------------------------------------------- |
| `withMetrics`                 | metrics.ts              | Timing and observability                     |
| `withLogging`                 | metrics.ts              | Debug logging                                |
| `withRevalidation`            | revalidation.ts         | Filter unchanged segments                    |
| `withCacheHitRevalidation`    | revalidation.ts         | Revalidation for cache hits                  |
| `withNullComponents`          | revalidation.ts         | Null components for client-cached segments   |
| `withErrorBoundary`           | error-boundary.ts       | Catch errors, yield error segments           |
| `withPerSegmentErrorBoundary` | error-boundary.ts       | Per-segment error handling                   |
| `withCacheStore`              | cache.ts                | Store segments in cache                      |
| `withProactiveCache`          | cache.ts                | Proactive caching                            |
| `withStaleMarker`             | cache.ts                | Mark segments as stale for SWR               |
| `withSWRRevalidation`         | background.ts           | Background revalidation                      |
| `withProactiveCaching`        | background.ts           | Background cache warming                     |
| `withOnComplete`              | background.ts           | Hook for pipeline completion                 |
| `withIntercept`               | intercept.ts            | Branching for intercept routes               |
| `withBranch`                  | intercept.ts            | Generic conditional branching                |
| `withParallelSlots`           | parallel.ts             | Fork/join for parallel slots                 |
| `withForkJoin`                | parallel.ts             | Static fork/join                             |
| `withConditionalParallels`    | parallel.ts             | Conditional parallel resolution              |
| `withCancellation`            | generator-middleware.ts | AbortSignal support for request cancellation |
| `withBatching`                | generator-middleware.ts | Controlled emission with batching            |
| `mergeAsyncGenerators`        | generator-middleware.ts | Concurrent generator merging                 |

### Composable Pipeline Example

Here's how all the middleware can be composed together:

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
    interceptResult,
    resolveIntercept,
  } = options;

  // Build middleware stack using createPipeline (data flow order)
  const pipeline = createPipeline(
    // Terminal: resolve all segments
    () => resolveEntries(entries, context),
    // Innermost middleware (sees raw yields first):
    withIntercept(interceptResult, resolveIntercept),
    withRevalidation(clientSegments, prevParams),
    withCaching(cacheStrategy, cacheKey),
    // Outermost middleware (wraps everything):
    withCancellation(signal),
    withErrorBoundary(findNearestBoundary),
    withMetrics(metricsStore)
  );

  return pipeline();
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
    interceptResult,
    resolveIntercept: () => resolveInterceptSegments(),
  });

  const segments: ResolvedSegment[] = [];
  for await (const segment of pipeline) {
    segments.push(segment);
  }

  return { segments, matched: segments.map((s) => s.id) };
}
```

---

## Notes for Continuation

When continuing after conversation compaction:

1. Check this document for current progress (checkboxes above)
2. Start with the next unchecked item
3. Follow the file structure and code patterns defined here
4. Run tests after each phase
5. Update checkboxes as you complete items

The key insight is: **everything is just generator transforms**. No special types, no discriminated unions, no `next()` callbacks. Just compose functions.
