# Loading State Architecture Refactor

## Problem Statement

Currently, loading states cannot display until loaders complete because:
1. We await all loaders before building segments
2. Segments are sent only after full resolution
3. `loading()` fallback is sent alongside resolved content (too late)

```
Current flow:
T+0ms:   Navigation starts
T+500ms: All loaders complete
T+501ms: Segments built with loading fallbacks
T+502ms: Client receives response, renders content (loading never shown)
```

## Goal

Display loading states immediately while content resolves in background:

```
Target flow:
T+0ms:   Navigation starts
T+5ms:   Loading segments sent to client
T+6ms:   Client renders loading states
T+500ms: Resolved segments stream in
T+501ms: Client swaps loading for actual content
```

## Solution: Two-Phase Partial Rendering

### Response Structure

```typescript
interface PartialRenderResult {
  loading: ResolvedSegment[];  // Phase 1: Immediate loading states
  resolve: Promise<{           // Phase 2: Deferred full resolution
    segments: ResolvedSegment[];
  }>;
  matched: string[];           // All matched segment IDs
  diff: string[];              // Segments that changed
}
```

### Server Flow

```typescript
async function matchPartial(request): Promise<PartialRenderResult | null> {
  // Step 1: Run revalidation checks (fast, determines WHAT to render)
  const { segmentsToRender, matched, diff } = await runRevalidationChecks();

  // Step 2: Collect loading segments (sync, immediate)
  const loadingSegments = collectLoadingSegments(segmentsToRender);

  // Step 3: Create deferred promise for full resolution
  const resolvePromise = resolveSegmentsDeferred(segmentsToRender);

  return {
    loading: loadingSegments,
    resolve: resolvePromise,
    matched,
    diff,
  };
}
```

### Client Flow

```typescript
async function fetchPartialUpdate(url) {
  const { payload } = await client.fetchPartial(url);

  // Immediate: Render loading states
  if (payload.loading?.length > 0) {
    const loadingTree = buildTree(payload.loading, cachedSegments, payload.matched);
    store.emit({ root: loadingTree, metadata: { isStreaming: true } });
  }

  // Deferred: Swap in resolved content when ready
  const resolved = await payload.resolve;
  const finalTree = buildTree(resolved.segments, cachedSegments, payload.matched);
  store.emit({ root: finalTree, metadata: { isStreaming: false } });
}
```

## Loading Phase Optimization

When collecting loading segments, skip children if parent has loading (they won't be visible):

### Rules

1. **Layout with loading()** → emit loading segment, skip all children
2. **Route with loading()** → emit loading segment, skip nested parallels
3. **Parallel with loading()** → emit loading segment, siblings process normally

### Implementation

```typescript
function collectLoadingSegments(segmentsToRender: EntryData[]): ResolvedSegment[] {
  const loadingSegments: ResolvedSegment[] = [];
  const skipSubtree = new Set<string>();

  for (const entry of traverseTopDown(segmentsToRender)) {
    // Skip if ancestor already has loading
    if (skipSubtree.has(entry.parentId)) {
      skipSubtree.add(entry.id);
      continue;
    }

    if (entry.loading) {
      loadingSegments.push({
        id: entry.shortCode,
        component: entry.loading,
        type: entry.type,
      });

      // Layout/Route blocks children, Parallel only affects itself
      if (entry.type === 'layout' || entry.type === 'route') {
        skipSubtree.add(entry.id);
      }
    }
  }

  return loadingSegments;
}
```

### Example: Layout Has Loading

```
Route tree:
  RootLayout
    BlogLayout (has loading)
      BlogPost
      @sidebar

Loading phase:
  ✓ RootLayout     → no loading, continue (or use cached)
  ✓ BlogLayout     → HAS loading, emit <BlogLayoutSkeleton/>
  ✗ BlogPost       → SKIP (parent loading)
  ✗ @sidebar       → SKIP (parent loading)

Result: Only BlogLayoutSkeleton sent immediately
```

### Example: Only Route Has Loading

```
Route tree:
  BlogLayout
    BlogPost (has loading)
      @related

Loading phase:
  ✗ BlogLayout     → no loading, use cached
  ✓ BlogPost       → HAS loading, emit <PostSkeleton/>
  ✗ @related       → SKIP (parent route loading)

Result: PostSkeleton sent, BlogLayout from cache
```

### Example: Only Parallel Has Loading

```
Route tree:
  BlogLayout
    BlogPost
    @sidebar (has loading)

Loading phase:
  ✗ BlogLayout     → no loading, use cached
  ✗ BlogPost       → no loading, must wait for resolve (or cache)
  ✓ @sidebar       → HAS loading, emit <SidebarSkeleton/>

Result: SidebarSkeleton sent, BlogPost waits for resolve
```

## Scope

### In Scope

- Partial navigation (client-side nav with `_rsc_partial=true`)
- Loading phase optimization (skip hidden children)
- Two-phase response structure

### Out of Scope (Unchanged)

- SSR initial page load (fully resolves before sending)
- Full document requests (non-partial)
- Action handling (existing flow)

## Implementation Plan

### Phase 1: Response Structure

1. Update `PartialRenderResult` type in `router.ts`
2. Modify `matchPartial` to return `{ loading, resolve, matched, diff }`
3. Update RSC payload serialization to handle deferred promise

### Phase 2: Loading Collection

1. Add `collectLoadingSegments()` function
2. Implement skip-subtree optimization
3. Ensure loading segments have correct IDs for client merge

### Phase 3: Client Updates

1. Update `partial-update.ts` to handle two-phase response
2. Modify `fetchPartialUpdate` to emit loading tree immediately
3. Handle `isStreaming` state for UI feedback

### Phase 4: Testing

1. Test layout with loading
2. Test route with loading
3. Test parallel with loading
4. Test nested loading scenarios
5. Test revalidation with loading
6. Verify SSR unchanged

## File Changes

```
packages/rsc-router/src/
├── router.ts              # matchPartial returns { loading, resolve }
├── types.ts               # PartialRenderResult type
├── segment-system.tsx     # May need updates for loading tree
└── browser/
    └── partial-update.ts  # Two-phase handling

examples/vite-rsc-demo/src/
└── entry.rsc.tsx          # Handle new response structure
```

## Migration

No breaking changes to user-facing API:
- `loading()` in route definitions works the same
- Behavior change is internal (loading shows faster)

## Success Criteria

1. Loading states visible within ~10ms of navigation start
2. No regression in SSR performance
3. Existing tests pass
4. New loading scenarios covered by tests
