# Phase 7.7: Client Segment Store

**Status**: ✅ Complete
**Date**: 2025-11-09
**Test Count**: 26 tests (all passing)
**Total Tests**: 427 tests (100% passing)

---

## Objective

Implement client-side segment store for tracking rendered segments during SPA navigation. This store maintains the client's current state of segments, enabling efficient communication with the server through the `_has` parameter and reconciliation with server responses.

The segment store provides:
- **State tracking**: Which segments are currently rendered
- **CRUD operations**: Add, remove, update, query segments
- **Reconciliation**: Sync with server's segment list
- **Ordering**: Maintain segments in index order

---

## Approach: Test-Driven Development

### RED Phase: Write Failing Tests

Created `client-segment-store.test.tsx` with comprehensive coverage:
- Initialization (empty and with initial segments)
- CRUD operations (add, remove, update, get)
- Query operations (has, getAll, getIds, size, isEmpty)
- Reconciliation with server segment list
- Edge cases (empty store, non-existent segments)

**Result**: 26 failing tests

### GREEN Phase: Implement SegmentStore

Added `SegmentStore` class to `client.ts`:
- Map-based storage for O(1) lookups
- All CRUD and query methods
- Reconciliation logic
- Comprehensive JSDoc documentation

**Result**: All 26 tests passing

### REFACTOR Phase

No refactoring needed - implementation is clean and efficient.

---

## Implementation Details

### SegmentStore Class

```typescript
export class SegmentStore {
  private segments: Map<string, Segment>;

  constructor(initialSegments?: Segment[]) {
    this.segments = new Map();
    if (initialSegments) {
      for (const segment of initialSegments) {
        this.segments.set(segment.id, segment);
      }
    }
  }

  // CRUD operations
  addSegment(segment: Segment): void
  removeSegment(segmentId: string): void
  updateSegment(segmentId: string, segment: Segment): void

  // Query operations
  has(segmentId: string): boolean
  get(segmentId: string): Segment | undefined
  getAll(): Segment[]  // Sorted by index
  getIds(): string[]   // Sorted by index
  size(): number
  isEmpty(): boolean
  clear(): void

  // Reconciliation
  reconcile(serverSegmentIds: string[]): void
}
```

### Key Features

1. **Map-Based Storage**: O(1) lookups for has() and get()
2. **Automatic Ordering**: getAll() and getIds() sort by index
3. **Idempotent Updates**: Adding same ID replaces existing
4. **Smart Reconciliation**: Removes segments not in server list
5. **Memory Efficient**: Only stores active segments

---

## Test Coverage

### Test File: `client-segment-store.test.tsx`

**26 comprehensive tests organized into 10 suites:**

#### 1. Initialization (2 tests)
- ✅ Initializes with empty segment set
- ✅ Accepts initial segments in constructor

#### 2. addSegment() (3 tests)
- ✅ Adds a segment to the store
- ✅ Adds multiple segments
- ✅ Replaces existing segment with same ID

#### 3. removeSegment() (3 tests)
- ✅ Removes a segment by ID
- ✅ Handles removing non-existent segment gracefully
- ✅ Removes multiple segments

#### 4. updateSegment() (2 tests)
- ✅ Updates an existing segment
- ✅ Adds segment if it does not exist

#### 5. has() (2 tests)
- ✅ Returns true for existing segment
- ✅ Returns false for non-existing segment

#### 6. get() (2 tests)
- ✅ Returns segment by ID
- ✅ Returns undefined for non-existing segment

#### 7. getAll() (3 tests)
- ✅ Returns empty array when store is empty
- ✅ Returns all segments
- ✅ Returns segments in order by index

#### 8. getIds() (3 tests)
- ✅ Returns empty array when store is empty
- ✅ Returns all segment IDs
- ✅ Returns IDs in order by index

#### 9. clear() and size()/isEmpty() (2 tests)
- ✅ Removes all segments
- ✅ Returns correct size and isEmpty state

#### 10. Reconciliation (4 tests)
- ✅ Reconciles with server segment list
- ✅ Removes all segments when server list is empty
- ✅ Keeps all segments when they match server list
- ✅ Handles partial overlap correctly

---

## Usage Examples

### Basic Usage

```typescript
import { SegmentStore } from 'rsc-router/client';

// Initialize store
const store = new SegmentStore();

// Add segments from initial render
store.addSegment({
  id: 'L0',
  type: 'layout',
  index: 0,
  component: RootLayout,
  path: '/'
});

store.addSegment({
  id: 'R1',
  type: 'route',
  index: 1,
  component: HomePage,
  path: '/'
});

console.log(store.size());      // 2
console.log(store.getIds());    // ['L0', 'R1']
console.log(store.has('L0'));   // true
```

### Navigation with _has Parameter

```typescript
// During SPA navigation, send current state to server
async function navigateToRoute(pathname: string) {
  const store = getSegmentStore(); // Get global store instance

  // Build _has parameter from current segments
  const currentSegments = store.getIds();
  const hasParam = currentSegments.join(','); // "L0,R1"

  // Fetch with _has parameter
  const response = await fetch(`${pathname}?_has=${hasParam}`, {
    headers: { 'Accept': 'application/x-rsc' }
  });

  const payload = await response.json();

  // Process payload (Phase 7.8-7.9 will implement this)
  // ...
}
```

### Reconciliation After Server Response

```typescript
// After receiving server response
async function processServerResponse(payload: RSCPayload) {
  const store = getSegmentStore();

  // 1. Reconcile - remove segments not in server list
  store.reconcile(payload.segments);
  // If client had ['L0', 'R1', 'P2'] and server says ['L0', 'R1', 'R3']
  // Store now has ['L0', 'R1'] (P2 removed)

  // 2. Update/add segments from server's updates
  for (const [segmentId, component] of Object.entries(payload.updates)) {
    if (store.has(segmentId)) {
      // Update existing segment
      store.updateSegment(segmentId, {
        id: segmentId,
        component,
        // ... other properties
      });
    } else {
      // Add new segment
      store.addSegment({
        id: segmentId,
        component,
        // ... other properties
      });
    }
  }

  // 3. Render updated tree
  renderSegmentTree(store.getAll());
}
```

### Initialization with Pre-Rendered Segments

```typescript
// On initial page load, hydrate with SSR segments
const initialSegments: Segment[] = [
  { id: 'L0', type: 'layout', index: 0, component: RootLayout, path: '/blog' },
  { id: 'L1', type: 'layout', index: 1, component: BlogLayout, path: '/blog' },
  { id: 'R2', type: 'route', index: 2, component: BlogPost, path: '/blog/123', params: { slug: '123' } }
];

const store = new SegmentStore(initialSegments);
console.log(store.size()); // 3
console.log(store.getIds()); // ['L0', 'L1', 'R2']
```

### Querying Store State

```typescript
const store = getSegmentStore();

// Check if segment exists
if (store.has('L0')) {
  const layout = store.get('L0');
  console.log(layout?.path); // '/blog'
}

// Get all segments in order
const allSegments = store.getAll();
// Always sorted by index: [L0, L1, R2, P3, ...]

// Get just the IDs
const ids = store.getIds();
// ['L0', 'L1', 'R2', 'P3']

// Check store state
console.log(store.isEmpty());  // false
console.log(store.size());     // 4
```

### Clear and Reset

```typescript
// Clear all segments (e.g., on logout or route change)
store.clear();
console.log(store.isEmpty()); // true
console.log(store.size());    // 0
```

---

## Integration with Partial Rendering Pipeline

The segment store is the foundation for client-side navigation:

```typescript
class ClientNavigationHandler {
  private store: SegmentStore;

  constructor() {
    // Initialize with SSR-rendered segments
    this.store = new SegmentStore(window.__INITIAL_SEGMENTS__);
  }

  async navigate(pathname: string) {
    // 1. Get current segment IDs for _has parameter
    const currentSegmentIds = this.store.getIds();
    const hasParam = currentSegmentIds.join(',');

    // 2. Fetch from server with current state
    const response = await fetch(`${pathname}?_has=${hasParam}`, {
      headers: { 'Accept': 'application/x-rsc' }
    });

    const payload = await response.json();

    // 3. Reconcile - remove segments not in server's list
    this.store.reconcile(payload.segments);

    // 4. Update/add segments from server's updates
    for (const [segmentId, component] of Object.entries(payload.updates)) {
      const segment: Segment = {
        id: segmentId,
        component,
        // Extract type and index from ID
        ...this.parseSegmentId(segmentId)
      };

      if (this.store.has(segmentId)) {
        this.store.updateSegment(segmentId, segment);
      } else {
        this.store.addSegment(segment);
      }
    }

    // 5. Render updated segment tree (Phase 7.9 will implement this)
    this.renderTree(this.store.getAll());
  }

  private parseSegmentId(id: string) {
    // Parse 'L0', 'R1', etc.
    // Will use segment-system.ts functions
    // ...
  }
}
```

---

## Design Decisions

### 1. Map-Based Storage

**Decision**: Use `Map<string, Segment>` for internal storage

**Rationale**:
- O(1) lookups for has() and get()
- Native JavaScript data structure
- Maintains insertion order
- Easy iteration with .keys(), .values(), .entries()
- Memory efficient for typical segment counts (<100)

### 2. Automatic Sorting in getAll() / getIds()

**Decision**: Sort by segment index when returning all segments/IDs

**Rationale**:
- Segments must render in specific order (L0, L1, R2, P3, ...)
- Index determines nesting hierarchy
- Consistent ordering prevents rendering bugs
- Small performance cost (O(n log n)) acceptable for small n

### 3. Idempotent Add/Update

**Decision**: addSegment() and updateSegment() both use set(), allowing replacement

**Rationale**:
- Simpler API - users don't need to check if segment exists first
- Matches Map.set() behavior
- Common pattern in state management
- Makes reconciliation easier

### 4. Reconciliation Removes Only

**Decision**: reconcile() only removes segments, doesn't add new ones

**Rationale**:
- Clear separation of concerns
- Adding segments requires full segment data (component, params, etc.)
- Server only sends IDs in segments array
- Actual components come in updates object
- Prevents partial/incomplete segments in store

### 5. No Built-in Persistence

**Decision**: Store doesn't automatically persist to localStorage/sessionStorage

**Rationale**:
- Segments contain React components (not serializable)
- Persistence would need custom serialization strategy
- Different apps have different persistence needs
- Keep store simple and focused
- Users can implement persistence wrapper if needed

### 6. Constructor Accepts Initial Segments

**Decision**: Allow optional initial segments in constructor

**Rationale**:
- Useful for SSR hydration
- Single initialization point
- Cleaner than calling addSegment() multiple times
- Common pattern in state management libraries

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| addSegment() | O(1) | Map.set() |
| removeSegment() | O(1) | Map.delete() |
| updateSegment() | O(1) | Map.set() |
| has() | O(1) | Map.has() |
| get() | O(1) | Map.get() |
| size() | O(1) | Map.size |
| isEmpty() | O(1) | Map.size === 0 |
| clear() | O(1) | Map.clear() |
| getAll() | O(n log n) | Sort by index |
| getIds() | O(n log n) | getAll() + map() |
| reconcile() | O(n + m) | n = store size, m = server list size |

### Space Complexity

- **Storage**: O(n) where n = number of segments
- **getAll()**: O(n) for sorted array copy
- **reconcile()**: O(m) for server segment Set

### Typical Performance

```typescript
// Benchmark: Store with 10 segments
const store = new SegmentStore();

// Add 10 segments
console.time('add');
for (let i = 0; i < 10; i++) {
  store.addSegment({
    id: `L${i}`,
    type: 'layout',
    index: i,
    component: Layout,
    path: '/test'
  });
}
console.timeEnd('add'); // < 1ms

// Get all (with sorting)
console.time('getAll');
const all = store.getAll();
console.timeEnd('getAll'); // < 0.1ms

// Reconcile
console.time('reconcile');
store.reconcile(['L0', 'L1', 'L2']); // Keep 3, remove 7
console.timeEnd('reconcile'); // < 0.1ms
```

Very fast for typical segment counts (5-20 segments per route).

---

## Files Changed

### Created Files
1. **`src/__tests__/client-segment-store.test.tsx`** (26 tests)
   - Comprehensive test suite for SegmentStore
   - Covers all methods and edge cases

### Modified Files
1. **`src/client.ts`**
   - Added SegmentStore class
   - Added comprehensive JSDoc documentation
   - Exported SegmentStore for client-side use

---

## Test Results

### Phase 7.7 Tests
```
✓ src/__tests__/client-segment-store.test.tsx (26 tests) 5ms
  ✓ Phase 7.7: Client Segment Store
    ✓ Initialization (2 tests)
    ✓ addSegment() (3 tests)
    ✓ removeSegment() (3 tests)
    ✓ updateSegment() (2 tests)
    ✓ has() (2 tests)
    ✓ get() (2 tests)
    ✓ getAll() (3 tests)
    ✓ getIds() (3 tests)
    ✓ clear() and size()/isEmpty() (2 tests)
    ✓ Reconciliation (4 tests)
```

### Full Test Suite
```
Test Files  29 passed (29)
     Tests  427 passed (427)
  Duration  2.44s
```

**Status**: ✅ **100% passing**

---

## Success Criteria

All criteria met:

- [x] SegmentStore class implemented
- [x] addSegment() method (with replacement)
- [x] removeSegment() method
- [x] updateSegment() method
- [x] has() query method
- [x] get() query method
- [x] getAll() method (sorted by index)
- [x] getIds() method (sorted by index)
- [x] size() and isEmpty() methods
- [x] clear() method
- [x] reconcile() method for server sync
- [x] Constructor accepts initial segments
- [x] Comprehensive test coverage (26 tests)
- [x] All existing tests still pass (427 total)
- [x] Well-documented with JSDoc
- [x] Performance is O(1) for most operations

---

## Next Steps

### Remaining for Full Partial Rendering:

**Phase 7.8**: Client Navigation Protocol (NEXT)
- `navigateToRoute()` function
- `_has` parameter construction
- RSC fetch with proper headers
- `createFromFetch` integration
- Error handling

**Phase 7.9**: Client Segment Reconciliation
- `processPayload()` logic
- `reconstructTreeFromSegments()` tree building
- OutletProvider composition
- Segment addition/removal/update

**Phase 7.10**: Loading/Error Boundaries
- Per-segment boundaries
- Error isolation
- Loading states during navigation

### Future Enhancements:

1. **React Hooks**: `useSegmentStore()` hook for React components
2. **Persistence**: Optional localStorage/sessionStorage sync
3. **DevTools**: Browser extension for debugging segment state
4. **Performance Monitoring**: Track reconciliation metrics

---

## Conclusion

Phase 7.7 successfully implements client-side segment storage:

- **26 new tests** (all passing)
- **427 total tests** (100% passing)
- **Clean API** (CRUD + reconciliation)
- **Efficient** (O(1) for most operations)
- **Type-safe** (full TypeScript support)
- **Well-documented** (comprehensive JSDoc)

The segment store provides the foundation for tracking client-side rendering state and communicating with the server during navigation.

**Status**: ✅ **READY FOR INTEGRATION**

---

**Generated**: 2025-11-09
**Phase**: 7.7 of 35
**Completion**: 30/35 phases (86%)

**Note**: Client-side state tracking complete! Next steps focus on navigation protocol (Phase 7.8) and segment reconciliation (Phase 7.9) to enable full SPA navigation with partial rendering.
