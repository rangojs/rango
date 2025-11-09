# Phase 7.8: Client Navigation Protocol

**Status**: ✅ Complete
**Date**: 2025-11-09
**Test Count**: 17 tests (all passing)
**Total Tests**: 444 tests (100% passing)

---

## Objective

Implement client-side navigation protocol with `_has` parameter support. This function enables SPA navigation by communicating the client's current segment state to the server, allowing differential rendering.

The navigation protocol:
- Constructs URLs with `_has` parameter (current segment IDs)
- Sends requests with RSC headers (`Accept: application/x-rsc`)
- Parses RSC payload responses
- Handles errors gracefully

---

## Approach: Test-Driven Development

### RED Phase: Write Failing Tests

Created `client-navigation.test.tsx` with comprehensive coverage:
- URL construction (with/without _has, query params)
- Request headers (Accept, custom headers)
- Response handling (success, errors, malformed JSON)
- Options (baseUrl, fetch options)
- Edge cases (empty pathname, hash, network errors)

**Result**: 17 failing tests

### GREEN Phase: Implement Navigation

Added to `client.ts`:
1. `NavigationOptions` interface - type-safe options
2. `navigateToRoute()` function - navigation implementation
3. Comprehensive JSDoc documentation

**Result**: All 17 tests passing

### REFACTOR Phase

No refactoring needed - implementation is clean and focused.

---

## Implementation Details

### NavigationOptions Interface

```typescript
export interface NavigationOptions extends Omit<RequestInit, 'method' | 'body'> {
  /**
   * Segment store instance
   * Used to send current segments via _has parameter
   */
  store: SegmentStore;

  /**
   * Base URL for the request
   * Defaults to current origin
   */
  baseUrl?: string;

  /**
   * Additional headers to send with the request
   * Merged with default headers (Accept: application/x-rsc)
   */
  headers?: HeadersInit;
}
```

### navigateToRoute() Function

```typescript
export async function navigateToRoute(
  pathname: string,
  options: NavigationOptions
): Promise<RSCPayload> {
  const { store, baseUrl, headers: customHeaders, ...fetchOptions } = options;

  // 1. Build URL with _has parameter
  const url = new URL(pathname, baseUrl || window.location.origin);
  const currentSegmentIds = store.getIds();
  if (currentSegmentIds.length > 0) {
    url.searchParams.set('_has', currentSegmentIds.join(','));
  }

  // 2. Prepare headers
  const headers = {
    Accept: 'application/x-rsc',
    ...customHeaders
  };

  // 3. Fetch from server
  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
    method: 'GET',
  });

  // 4. Check response status
  if (!response.ok) {
    throw new Error(`Navigation failed: ${response.status} ${response.statusText}`);
  }

  // 5. Parse RSC payload
  return await response.json();
}
```

### Key Features

1. **_has Parameter**: Automatically adds current segment IDs
2. **RSC Headers**: Sets Accept header for RSC responses
3. **URL Building**: Uses native URL API for proper encoding
4. **Error Handling**: Throws on network/HTTP errors
5. **Flexible Options**: Extends RequestInit for full fetch control
6. **Type-Safe**: Full TypeScript support

---

## Test Coverage

### Test File: `client-navigation.test.tsx`

**17 comprehensive tests organized into 5 suites:**

#### 1. URL Construction (5 tests)
- ✅ Constructs URL with pathname
- ✅ Adds _has parameter with current segments
- ✅ Does not add _has when store is empty
- ✅ Preserves existing query parameters
- ✅ Combines _has with existing query parameters

#### 2. Request Headers (3 tests)
- ✅ Sets Accept header to application/x-rsc
- ✅ Merges custom headers with default headers
- ✅ Allows overriding Accept header

#### 3. Response Handling (3 tests)
- ✅ Returns RSC payload from response
- ✅ Throws error on non-ok response
- ✅ Throws error on network failure

#### 4. Options (3 tests)
- ✅ Accepts baseUrl option
- ✅ Uses current origin when baseUrl not provided
- ✅ Passes through fetch options (signal, etc.)

#### 5. Edge Cases (3 tests)
- ✅ Handles empty pathname (/)
- ✅ Handles pathname with hash
- ✅ Handles malformed JSON response

---

## Usage Examples

### Basic Navigation

```typescript
import { navigateToRoute, SegmentStore } from 'rsc-router/client';

// Get or create store instance
const store = getSegmentStore();

// Navigate to new route
const payload = await navigateToRoute('/blog/123', { store });

// Process payload (Phase 7.9 will implement this)
console.log(payload.segments); // ['L0', 'L1', 'R2']
console.log(payload.updates);  // { R2: <BlogPost /> }
```

### Navigation with Existing Segments

```typescript
const store = new SegmentStore();

// Initial navigation - no segments
let payload = await navigateToRoute('/blog', { store });
// Request: GET /blog (no _has parameter)
// Response: { segments: ['L0', 'R1'], updates: { L0: <Layout />, R1: <Blog /> } }

// Add segments to store
payload.segments.forEach(id => {
  store.addSegment({ id, /* ... */ });
});

// Second navigation - with segments
payload = await navigateToRoute('/blog/123', { store });
// Request: GET /blog/123?_has=L0,R1
// Response: { segments: ['L0', 'R2'], updates: { R2: <Post /> } }
// Server only sends R2 since client already has L0
```

### With Custom Headers

```typescript
const payload = await navigateToRoute('/blog/123', {
  store,
  headers: {
    'X-Custom-Header': 'value',
    'Authorization': 'Bearer token'
  }
});
// Request includes both RSC and custom headers
```

### With Abort Controller

```typescript
const controller = new AbortController();

try {
  const payload = await navigateToRoute('/blog/123', {
    store,
    signal: controller.signal
  });
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Navigation cancelled');
  }
}

// Later: controller.abort()
```

### With Custom Base URL

```typescript
// Navigate to different origin
const payload = await navigateToRoute('/api/content', {
  store,
  baseUrl: 'https://api.example.com'
});
// Request: GET https://api.example.com/api/content?_has=...
```

### Error Handling

```typescript
try {
  const payload = await navigateToRoute('/blog/123', { store });
} catch (error) {
  if (error.message.includes('404')) {
    // Handle not found
    console.error('Page not found');
  } else if (error.message.includes('500')) {
    // Handle server error
    console.error('Server error');
  } else {
    // Handle network error
    console.error('Network error:', error);
  }
}
```

---

## Integration with Navigation Flow

Complete navigation flow using all phases:

```typescript
class NavigationHandler {
  private store: SegmentStore;

  constructor(initialSegments: Segment[]) {
    this.store = new SegmentStore(initialSegments);
  }

  async navigate(pathname: string) {
    try {
      // Phase 7.8: Fetch with _has parameter
      const payload = await navigateToRoute(pathname, {
        store: this.store
      });

      // Phase 7.7: Reconcile - remove segments not in server list
      this.store.reconcile(payload.segments);

      // Phase 7.9: Update segments with server's updates (next phase)
      for (const [segmentId, component] of Object.entries(payload.updates)) {
        // Parse segment info from ID
        const { type, index } = parseSegmentId(segmentId);

        const segment: Segment = {
          id: segmentId,
          type,
          index,
          component,
          path: pathname
        };

        if (this.store.has(segmentId)) {
          this.store.updateSegment(segmentId, segment);
        } else {
          this.store.addSegment(segment);
        }
      }

      // Phase 7.9: Render updated tree (next phase)
      this.renderTree(this.store.getAll());

    } catch (error) {
      console.error('Navigation failed:', error);
      // Show error UI
    }
  }

  private renderTree(segments: Segment[]) {
    // Will be implemented in Phase 7.9
  }
}
```

---

## Design Decisions

### 1. URL API for Construction

**Decision**: Use native `URL` class for URL construction

**Rationale**:
- Handles URL encoding automatically (commas → %2C)
- Properly merges query parameters
- Works with relative and absolute URLs
- Browser-standard API
- No manual string concatenation

### 2. _has Parameter Format

**Decision**: Comma-separated segment IDs (e.g., `_has=L0,L1,R2`)

**Rationale**:
- Simple to construct: `ids.join(',')`
- Simple to parse server-side: `split(',')`
- URL-safe (commas encoded as %2C)
- Compact representation
- Matches design doc specification

### 3. Accept Header Default

**Decision**: Always set `Accept: application/x-rsc` by default

**Rationale**:
- Server needs to know client expects RSC format
- Enables content negotiation
- Can be overridden if needed
- Standard HTTP practice
- Matches design doc (lines 296-300)

### 4. Error on Non-OK Response

**Decision**: Throw error if `!response.ok`

**Rationale**:
- Fail fast on server errors
- Prevents silent failures
- Clear error messages
- Allows caller to handle errors appropriately
- Standard fetch pattern

### 5. Extends RequestInit

**Decision**: NavigationOptions extends RequestInit

**Rationale**:
- Access to all fetch options (signal, credentials, etc.)
- Future-proof for new fetch features
- Familiar API for developers
- Type-safe with TypeScript
- Omit method/body to enforce GET

### 6. No Automatic Payload Processing

**Decision**: Return raw payload, don't auto-update store

**Rationale**:
- Single responsibility - navigation fetches data
- Caller controls when/how to process
- Separation of concerns
- Allows intermediate processing
- Phase 7.9 will handle processing

---

## Performance Characteristics

### Time Complexity

- **URL construction**: O(n) where n = number of segments
- **Header merging**: O(m) where m = number of headers
- **Overall**: O(n + m) + network time

### Network Performance

```typescript
// Typical request
GET /blog/123?_has=L0,L1,R2
Accept: application/x-rsc

// Response size (differential)
{
  segments: ['L0', 'L1', 'R3'],  // ~20 bytes
  updates: {
    R3: <Component />  // Only new segment
  }
}
// Total: ~1-10KB vs full page reload (~100KB+)
```

### Bandwidth Savings

- **Full page**: 100-500KB HTML + hydration data
- **Partial update**: 1-10KB RSC payload
- **Savings**: 90-99% reduction in data transfer

---

## Files Changed

### Created Files
1. **`src/__tests__/client-navigation.test.tsx`** (17 tests)
   - Comprehensive test suite for navigation protocol
   - Covers all scenarios and edge cases

### Modified Files
1. **`src/client.ts`**
   - Added `NavigationOptions` interface
   - Added `navigateToRoute()` function
   - Imported `RSCPayload` type
   - Added comprehensive JSDoc documentation

---

## Test Results

### Phase 7.8 Tests
```
✓ src/__tests__/client-navigation.test.tsx (17 tests) 8ms
  ✓ Phase 7.8: Client Navigation Protocol
    ✓ navigateToRoute()
      ✓ URL construction (5 tests)
      ✓ Request headers (3 tests)
      ✓ Response handling (3 tests)
      ✓ Options (3 tests)
      ✓ Edge cases (3 tests)
```

### Full Test Suite
```
Test Files  30 passed (30)
     Tests  444 passed (444)
  Duration  2.27s
```

**Status**: ✅ **100% passing**

---

## Success Criteria

All criteria met:

- [x] NavigationOptions interface defined
- [x] navigateToRoute() function implemented
- [x] URL construction with _has parameter
- [x] Preserves existing query parameters
- [x] Sets Accept: application/x-rsc header
- [x] Supports custom headers
- [x] Supports fetch options (signal, etc.)
- [x] Error handling (non-ok, network)
- [x] Returns RSCPayload type
- [x] Comprehensive test coverage (17 tests)
- [x] All existing tests still pass (444 total)
- [x] Well-documented with JSDoc
- [x] Type-safe implementation

---

## Next Steps

### Remaining for Full Partial Rendering:

**Phase 7.9**: Client Segment Reconciliation (NEXT)
- `processPayload()` function to handle server response
- `reconstructTreeFromSegments()` to build React tree
- OutletProvider composition
- Segment addition/removal/update
- Integration with rendering

**Phase 7.10**: Loading/Error Boundaries
- Per-segment loading states
- Per-segment error boundaries
- Error isolation
- Loading UI during navigation

### Future Enhancements:

1. **React Router Integration**: `useNavigate()` hook
2. **Link Component**: `<Link>` with automatic navigation
3. **Prefetching**: Prefetch routes on hover/intersection
4. **Cache Management**: Cache RSC payloads for back/forward
5. **Optimistic Updates**: Show UI before server response

---

## Conclusion

Phase 7.8 successfully implements client-side navigation protocol:

- **17 new tests** (all passing)
- **444 total tests** (100% passing)
- **Clean API** (navigateToRoute function)
- **_has protocol** (communicates client state)
- **RSC headers** (proper content negotiation)
- **Error handling** (robust error cases)
- **Type-safe** (full TypeScript support)
- **Well-documented** (comprehensive JSDoc)

The navigation function provides the foundation for client-side SPA navigation with differential rendering, enabling efficient communication between client and server.

**Status**: ✅ **READY FOR INTEGRATION**

---

**Generated**: 2025-11-09
**Phase**: 7.8 of 35
**Completion**: 31/35 phases (89%)

**Note**: Client-side navigation protocol complete! The client can now send its current state to the server and receive differential updates. Next step is payload processing and tree reconciliation (Phase 7.9).
