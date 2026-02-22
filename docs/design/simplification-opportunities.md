# RSC Router: Simplification Opportunities

Three areas where targeted refactoring would reduce complexity, eliminate bug classes, and create a cleaner foundation for future work.

---

## 1. Normalize Tree Depth (Eliminate Loading Category Bugs)

### Problem

The `loading` property on segments controls React tree structure via three categories:

| Category | `loading` value | Tree shape |
|---|---|---|
| **none** | `undefined` | `OutletProvider` directly |
| **suppressed** | `null` or `false` | `LoaderBoundary > Suspense > OutletProvider` |
| **active** | `ReactNode` | `LoaderBoundary > RouteContentWrapper > Suspense > OutletProvider` |

Changing categories between renders causes React to remount components, destroying `useActionState`, refs, and form state. Every merge path (action, navigation, stale-revalidation) must preserve the cached category via actor-specific rules in `segment-reconciler.ts`.

This produces a 3x3 matrix of "actor x loading category" rules spread across:

- `segment-reconciler.ts` -- actor-aware `loading` preservation
- `segment-system.tsx` -- conditional tree construction in `renderSegments()`
- `route-content-wrapper.tsx` -- `LoaderBoundary` / `RouteContentWrapper` nesting
- `segment-structure-assert.ts` -- dev-mode category drift detection
- `cache-scope.ts` -- `"null"` sentinel encoding to distinguish `null` from `undefined`

The `skipSSR` pattern is the primary trigger: SSR produces `loading=false` (suppressed), but SPA navigation produces `loading=<skeleton>` (active). Action revalidation must preserve whichever the client has.

Known bugs: P0-1 in `partial-update.ts` where `loading=false` is incorrectly cleared to `undefined` during navigation, changing tree structure.

### Proposed Change

Always render the full wrapper chain. Control behavior via props, not tree structure:

```tsx
// Before: three different tree shapes
if (loading !== null && loading !== undefined && loading !== false) {
  // LoaderBoundary > RouteContentWrapper > Suspense > OutletProvider
} else if (loading === false) {
  // LoaderBoundary > Suspense > OutletProvider
} else {
  // OutletProvider directly
}

// After: always same depth
<LoaderBoundary>
  <RouteContentWrapper>
    <Suspense fallback={loading ?? null}>
      <OutletProvider ... />
    </Suspense>
  </RouteContentWrapper>
</LoaderBoundary>
```

Apply the same principle to `MountContextProvider` -- always render it, pass `undefined` when no mount path.

### What This Removes

- `segment-structure-assert.ts` (entire file)
- `getLoadingCategory()` logic and the three-category system
- Actor-specific `loading` preservation branches in `segment-reconciler.ts`
- The `"null"` sentinel encoding/decoding in `cache-scope.ts`
- The P0-1 bug (cannot occur when tree shape is constant)

### Trade-offs

- Slightly deeper React tree for segments without loaders (the wrappers are cheap no-op pass-throughs when `loading` is undefined).
- Strictly safer: constant tree shape eliminates the entire class of remounting bugs.

### Impact: High | Effort: Medium | Risk: Low

---

## 2. Two-Phase Action Reconciliation

### Problem

Concurrent action handling is spread across four files with timing-dependent state:

- **`event-controller.ts`** -- `hadAnyConcurrentActions` sticky flag, `concurrentRevalidatedSegments` accumulator, `inflightActions` map, `activeStreamCount`
- **`server-action-bridge.ts`** -- 5-scenario classification, each with different behavior
- **`action-response-classifier.ts`** -- classification logic
- **`segment-reconciler.ts`** -- actor-aware merge rules

The 5 scenarios:

1. **`navigated-away`** -- user left the page during action
2. **`hmr-missing`** -- dev-mode module reload
3. **`consolidation-needed`** -- concurrent actions finished, refetch all segments they touched
4. **`concurrent-skip`** -- other actions still fetching, update cache but not UI
5. **`normal`** -- single action or last in batch, render normally

Which scenario an action hits depends on timing -- which response arrives first changes the code path for the second response. This makes the system hard to debug and reason about.

The `consolidation-needed` path triggers a separate refetch of the segments all concurrent actions touched, even though the store already has merged data from each individual action response.

### Proposed Change

Replace the 5-scenario classifier with a two-phase approach:

**Phase 1 -- Optimistic apply (every action response):**
Merge into the segment store/cache immediately, but do not render to the React tree if other actions are still in flight. This is what `concurrent-skip` already does -- make it the default for all concurrent actions.

**Phase 2 -- Single render (when batch completes):**
When `inflightActions.size === 0`, render once from the accumulated store state.

```
// Before: each action independently classifies and maybe renders
Action A finishes -> classify -> maybe render -> maybe refetch
Action B finishes -> classify -> maybe render -> maybe refetch

// After: defer rendering until batch is done
Action A finishes -> merge into store (no render)
Action B finishes -> merge into store -> batch done -> single render
```

Collapse to three scenarios:

1. **`navigated-away`** -- user left the page, discard
2. **`hmr-missing`** -- dev mode, refetch everything
3. **`apply`** -- merge into store, render if last action in batch

### What This Removes

- The `consolidation-needed` scenario and its separate refetch
- The `concurrent-skip` vs `normal` distinction
- The `hadAnyConcurrentActions` sticky flag
- The `concurrentRevalidatedSegments` accumulator set
- The `getConsolidationSegments()` method in EventController

### Trade-offs

- Changes observable behavior: instead of rendering after each non-concurrent action, always defers to batch completion. For single actions (no concurrency), the batch is one action, so behavior is identical.
- Eliminates the intermediate stale render that the consolidation refetch was designed to correct.

### Impact: High | Effort: Medium | Risk: Medium

---

## 3. Cache Serialization Abstractions

### Problem

`cache-scope.ts` is ~580 lines mixing three concerns:

1. **Key management** -- 3 strategies (default, route-level override, store-level generator), prefix logic (`doc:`, `partial:`, `intercept:`), param sorting
2. **Serialization format** -- RSC Flight protocol (`renderToReadableStream` / `createFromReadableStream`), `streamToString` / `stringToStream` conversion, the `"null"` sentinel, handle data extraction/replay
3. **Store operations** -- get/set, TTL/SWR calculation, partial vs document cache rules, loader exclusion

The cache-lookup middleware (`cache-lookup.ts`) also duplicates deserialization + handle replay + loader resolution logic across separate prerender and runtime cache code paths.

### Proposed Changes

#### A. Extract `SegmentCodec`

Owns the serialization format:

```typescript
// segment-codec.ts
interface SegmentCodec {
  serialize(segments: ResolvedSegment[]): Promise<SerializedSegmentData[]>;
  deserialize(data: SerializedSegmentData[]): Promise<ResolvedSegment[]>;
}
```

Isolates Flight protocol details, stream-to-string conversion, and the `"null"` sentinel (if tree normalization hasn't removed it) into a single module. Changing serialization format (compression, binary encoding, different RSC version) requires touching one file.

#### B. Extract `HandleSnapshot`

Owns handle data lifecycle:

```typescript
// handle-snapshot.ts
interface HandleSnapshot {
  capture(segments: ResolvedSegment[], handleStore: HandleStore): Record<string, SegmentHandleData>;
  restore(handles: Record<string, SegmentHandleData>, handleStore: HandleStore): void;
}
```

Makes the boundary explicit: cache stores data, handle snapshot manages the `HandleStore` interaction. Currently inlined in `cache-scope.ts` and easy to get wrong (append vs replace causes handle bleeding across routes).

#### C. Unify prerender and runtime cache lookup

Both the prerender store and runtime cache store perform the same post-lookup operations:

1. Deserialize `SerializedSegmentData[]` to `ResolvedSegment[]`
2. Replay handle data into `HandleStore`
3. Resolve loaders (always fresh)
4. Nullify components for partial navigation

The only difference is key format and storage backend. A unified lookup interface:

```typescript
interface SegmentCacheLookup {
  lookup(pathname: string, params: Record<string, string>, opts: LookupOpts): Promise<CacheResult | null>;
}
```

Prerender store and runtime cache are both implementations, checked in priority order. Removes duplicated deserialization + handle replay + loader resolution code.

### What This Removes

- Duplicated deserialization logic between prerender and runtime cache paths
- Mixed concerns in `cache-scope.ts` (shrinks from ~580 to ~150 lines)
- Implicit coupling between serialization format and store operations

### Trade-offs

- More files, more interfaces. Each file has a single responsibility.
- No behavior change -- purely structural refactor.

### Impact: Medium | Effort: Low-Medium | Risk: Low

---

## Sequencing

The tree depth normalization should come first -- it eliminates the root cause of consistency bugs rather than managing symptoms. It also removes the `"null"` sentinel from cache serialization, simplifying the codec extraction that follows.

Recommended order:

1. **Normalize tree depth** -- highest value, removes a class of bugs
2. **Cache serialization abstractions** -- low risk, sets clean foundation
3. **Two-phase action reconciliation** -- highest complexity change, benefits from stable tree/cache layer underneath

---

## Files Referenced

### Tree structure consistency
- `packages/rangojs-router/src/segment-system.tsx`
- `packages/rangojs-router/src/route-content-wrapper.tsx`
- `packages/rangojs-router/src/browser/segment-reconciler.ts`
- `packages/rangojs-router/src/browser/segment-structure-assert.ts`
- `packages/rangojs-router/src/cache/cache-scope.ts`
- `packages/rangojs-router/src/browser/partial-update.ts`

### Concurrent action reconciliation
- `packages/rangojs-router/src/browser/event-controller.ts`
- `packages/rangojs-router/src/browser/server-action-bridge.ts`
- `packages/rangojs-router/src/browser/action-response-classifier.ts`
- `packages/rangojs-router/src/browser/segment-reconciler.ts`

### Cache serialization
- `packages/rangojs-router/src/cache/cache-scope.ts`
- `packages/rangojs-router/src/cache/memory-segment-store.ts`
- `packages/rangojs-router/src/router/match-middleware/cache-lookup.ts`
- `packages/rangojs-router/src/router/match-middleware/background-revalidation.ts`
- `packages/rangojs-router/src/prerender/store.ts`
- `packages/rangojs-router/src/server/handle-store.ts`
