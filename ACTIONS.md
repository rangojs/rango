# Server Actions Implementation Plan

## Status: Ready to Implement (Phase 1.3)

**Dependencies:** ✅ All met
- ✅ Revalidation system complete
- ✅ Middleware system complete
- ✅ Error handling & sanitization
- ✅ System param filtering
- ✅ HMR resilience

---

## Architecture Overview

### Flow Diagram

```
USER: Submits form or clicks button
  ↓
CLIENT: React calls server action function
  ↓
CLIENT: setServerCallback(actionId, args) triggered
  ↓
CLIENT: createTemporaryReferenceSet() - track object references
  ↓
CLIENT: encodeReply(args, { temporaryReferences }) - serialize
  ↓
CLIENT: POST with:
  - actionId in header/query
  - current segmentIds (_rsc_segments)
  - current URL
  - encoded args in body
  ↓
SERVER: entry.rsc.tsx receives request
  ↓
SERVER: Detect action request
  ↓
SERVER: createTemporaryReferenceSet() - MUST match client
  ↓
SERVER: decodeReply(body, { temporaryReferences }) - deserialize
  ↓
SERVER: Run MIDDLEWARE (auth, logging, etc.)
  ↓ (if middleware returns Response → return early)
  ↓
SERVER: loadServerAction(actionId) - get function
  ↓
SERVER: Execute action(ctx, ...args)
  ↓ (mutations happen here)
  ↓
SERVER: Run REVALIDATION via router.matchPartial()
  ↓ (determine which segments changed)
  ↓
SERVER: Return RSC payload with updated segments
  ↓
CLIENT: createFromFetch(response, { temporaryReferences })
  ↓
CLIENT: Store new segments
  ↓
CLIENT: Check if all MATCHED segments exist in storage
  ↓ (HMR resilience check)
  ↓ (if missing → refetch with empty segments)
  ↓
CLIENT: Merge segments and render
  ↓
UI UPDATES with fresh data
```

---

## Critical Design Agreements

### 1. Temporary References (CRITICAL)

**Why:** Prevents object reference loss during serialization/deserialization

**Usage:**
```typescript
// CLIENT:
const refs = createTemporaryReferenceSet();
const body = await encodeReply(args, { temporaryReferences: refs });
const payload = await createFromFetch(response, { temporaryReferences: refs });

// SERVER:
const refs = createTemporaryReferenceSet();
const args = await decodeReply(body, { temporaryReferences: refs });
const stream = renderToReadableStream(payload, { temporaryReferences: refs });
```

**RULE:** MUST use same references object for encode/decode pairs

### 2. Actions Return Segments Directly

**NOT this:**
```typescript
return {
  returnValue: { ok: true, data: result },
  segments: [...],
}
```

**YES this:**
```typescript
// Action response IS the RSC payload with updated segments
return renderToReadableStream({
  root: renderSegments(matchResult.segments),
  metadata: {
    matched: matchResult.matched,  // ALL segments that should exist
    diff: matchResult.diff,        // Only changed segments
    segments: matchResult.segments, // Full ResolvedSegment objects for diff
  },
});
```

**Why:** Simpler protocol, reuses existing partial navigation logic

### 3. HMR Recovery: Partial Refetch, Not Full Reload

**Current (FIXED):**
```typescript
if (missingSegments) {
  return fetchPartialUpdate(url, []); // Empty = send all
}
```

**NOT:**
```typescript
if (missingSegments) {
  window.location.href = url; // ❌ Full reload
}
```

**Server Behavior:**
```typescript
const clientSegments = url.searchParams.get('_rsc_segments')?.split(',') || [];

// If empty array → client has nothing, send ALL segments
if (clientSegments.length === 0) {
  return allSegments; // Include everything in diff
}
```

### 4. matched Array is Source of Truth

**Server sends:**
```typescript
{
  matched: ['L0.0', 'R1.0', 'R2.0'],  // Everything that SHOULD exist
  diff: ['R2.0'],                      // Only what changed
  segments: [ResolvedSegment<R2.0>],   // Full objects for diff only
}
```

**Client updates:**
```typescript
// 1. Store new segments from diff
payload.metadata.segments.forEach(s => storedSegments.set(s.id, s));

// 2. Update currentSegmentIds from matched (source of truth)
navigationManager.currentSegmentIds = payload.metadata.matched;

// 3. Reconstruct full tree from matched
const fullSegments = matched.map(id => storedSegments.get(id));

// 4. Verify all exist (HMR check)
if (fullSegments.some(s => !s)) {
  refetchWithEmptySegments();
}
```

---

## Implementation Plan

### Part 1: Server-Side (entry.rsc.tsx)

**Files to modify:**
- `examples/vite-rsc-demo/src/entry.rsc.tsx`

**Add before existing rendering logic:**

```typescript
// Parse request
const url = new URL(request.url);
const isAction = request.headers.has('rsc-action') || url.searchParams.has('_rsc_action');
const actionId = request.headers.get('rsc-action') || url.searchParams.get('_rsc_action');

if (isAction && actionId) {
  console.log(`[RSC] >>> ACTION REQUEST: ${actionId}`);

  // 1. Create temporary references for decoding
  const temporaryReferences = createTemporaryReferenceSet();

  // 2. Decode action arguments
  const body = await request.text();
  const args = await decodeReply(body, { temporaryReferences });

  // 3. Create context & run middleware
  const matched = findMatchForUrl(url.href); // Use action's target URL
  const context = createHandlerContext(matched.params, request, ...);

  try {
    const middlewareResponse = await executeMiddleware(matched.middleware, context);
    if (middlewareResponse) {
      console.log(`[RSC] Middleware blocked action`);
      return middlewareResponse; // Auth failed, rate limited, etc.
    }
  } catch (error) {
    return sanitizeError(error);
  }

  // 4. Load and execute server action
  const action = await loadServerAction(actionId);
  console.log(`[RSC] Executing action...`);

  try {
    await action(context, ...args); // Pass context + args
  } catch (error) {
    console.error(`[RSC] Action error:`, error);
    return sanitizeError(error);
  }

  // 5. Revalidate to determine updated segments
  const matchResult = await router.matchPartial(request, context);

  if (!matchResult) {
    // Fall back to full render
    const fullMatch = await router.match(request, context);
    const root = renderSegments(fullMatch.segments);

    const rscStream = renderToReadableStream({
      root,
      metadata: {
        segments: fullMatch.segments.map(s => ({ id: s.id, type: s.type, index: s.index })),
        matched: fullMatch.matched,
        diff: fullMatch.diff,
      },
    }, { temporaryReferences });

    return new Response(rscStream, {
      headers: { 'Content-Type': 'text/x-component;charset=utf-8' },
    });
  }

  // 6. Return updated segments (same format as partial navigation)
  const root = renderSegments(matchResult.segments);
  const rscStream = renderToReadableStream({
    root,
    metadata: {
      isPartial: true,
      segments: matchResult.segments,  // Full ResolvedSegment objects
      matched: matchResult.matched,    // ALL segment IDs
      diff: matchResult.diff,          // Only changed segment IDs
    },
  }, { temporaryReferences });

  console.log(`[RSC] Action complete - returning updated segments`);
  console.log(`[RSC] Matched: ${matchResult.matched.join(', ')}`);
  console.log(`[RSC] Diff: ${matchResult.diff.join(', ')}`);

  return new Response(rscStream, {
    headers: { 'Content-Type': 'text/x-component;charset=utf-8' },
  });
}

// ... existing GET rendering logic
```

### Part 2: Client-Side (entry.browser.tsx)

**Files to modify:**
- `examples/vite-rsc-demo/src/entry.browser.tsx`

**Add after imports:**

```typescript
import { setServerCallback, encodeReply, createTemporaryReferenceSet } from '@vitejs/plugin-rsc/browser';

// Setup server action callback
setServerCallback(async (id, args) => {
  console.log(`[Browser] >>> SERVER ACTION: ${id}`);
  console.log(`[Browser] Args:`, args);

  // 1. Create temporary references for serialization
  const temporaryReferences = createTemporaryReferenceSet();

  // 2. Build action request URL
  const url = new URL(window.location.href);
  url.searchParams.set('_rsc_action', id);
  url.searchParams.set('_rsc_segments', navigationManager.currentSegmentIds.join(','));

  // 3. Encode arguments
  const body = await encodeReply(args, { temporaryReferences });

  console.log(`[Browser] Sending action request to: ${url.href}`);
  console.log(`[Browser] Current segments: ${navigationManager.currentSegmentIds.join(', ')}`);

  // 4. Send action request
  const responsePromise = fetch(url, {
    method: 'POST',
    headers: {
      'rsc-action': id,
      'X-RSC-Router-Client-Path': navigationManager.currentUrl,
    },
    body,
  });

  // 5. Deserialize response (MUST use same temporaryReferences)
  const payload = await createFromFetch<RscPayload>(responsePromise, { temporaryReferences });

  console.log(`[Browser] Action response received:`, payload.metadata);

  // 6. Process same as partial navigation
  const { metadata } = payload;
  const { matched, diff, segments, isPartial } = metadata || {};

  if (isPartial) {
    // Store new segments
    segments?.forEach((segment: ResolvedSegment) => {
      navigationManager.storedSegments.set(segment.id, segment);
    });

    // Rebuild from matched (source of truth)
    const fullSegments = matched.map((id: string) =>
      navigationManager.storedSegments.get(id)
    ).filter(Boolean) as ResolvedSegment[];

    // HMR resilience check
    if (fullSegments.length < matched.length) {
      console.warn(`[Browser] Missing segments after action, refetching...`);
      return fetchPartialUpdate(window.location.href, []);
    }

    // Update state
    navigationManager.currentSegmentIds = matched;

    // Render
    const newTree = renderSegments(fullSegments);
    navigationManager.setPayload?.({ root: newTree, metadata });

    console.log(`[Browser] ✓ Action complete - UI updated`);
  } else {
    // Full update
    navigationManager.currentSegmentIds = matched || [];
    navigationManager.setPayload?.(payload);
  }

  // Actions don't return values (updates happen via RSC)
  return undefined;
});
```

### Part 3: Example Server Action

**Create:** `examples/vite-rsc-demo/src/actions/shop.actions.ts`

```typescript
'use server'

// Simple in-memory cart for demo (replace with DB in real app)
const carts = new Map<string, { items: Array<{ productId: string; quantity: number }> }>();

export async function addToCart(productId: string, quantity: number = 1) {
  console.log(`[Action] addToCart: ${productId} x${quantity}`);

  // Get or create cart
  const cartId = 'demo-cart'; // In real app: get from session/user
  let cart = carts.get(cartId);

  if (!cart) {
    cart = { items: [] };
    carts.set(cartId, cart);
  }

  // Add item
  const existing = cart.items.find(item => item.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  console.log(`[Action] Cart updated:`, cart);

  // No return value needed - revalidation handles updates
}

export async function removeFromCart(productId: string) {
  const cartId = 'demo-cart';
  const cart = carts.get(cartId);

  if (cart) {
    cart.items = cart.items.filter(item => item.productId !== productId);
  }
}

export async function getCartCount(): Promise<number> {
  const cart = carts.get('demo-cart');
  return cart?.items.reduce((sum, item) => sum + item.quantity, 0) || 0;
}
```

### Part 4: Use Action in Component

**Update:** `examples/vite-rsc-demo/src/handlers/shop.tsx`

**Add import:**
```typescript
import { addToCart } from '../actions/shop.actions.js';
```

**Add to product detail:**
```typescript
"products.detail": async (ctx) => {
  const product = products.find(p => p.slug === ctx.params.slug);
  const cartCount = await getCartCount();

  return (
    <div>
      <h2>{product.name}</h2>
      <p>${product.price}</p>

      {/* Server Action Button */}
      <form>
        <button formAction={addToCart.bind(null, product.id, 1)}>
          Add to Cart
        </button>
      </form>

      <p>Cart: {cartCount} items</p>
    </div>
  );
}
```

---

## Key Implementation Details

### matched vs diff vs segments

**matched:** Array of ALL segment IDs that should exist on client
- Source of truth for what the page should render
- Client updates `currentSegmentIds` to this value
- Used to rebuild full segment tree

**diff:** Array of segment IDs that CHANGED (new or revalidated)
- Server only sends full objects for these
- Optimization: don't send unchanged segments

**segments:** Array of full `ResolvedSegment` objects for items in diff
- Includes component, id, type, index, params
- Client stores these in `storedSegments` Map

**Example:**
```typescript
// Client has: L0.0, R1.0, R2.0
// User adds to cart → R2.0 (cart) needs update

{
  matched: ['L0.0', 'R1.0', 'R2.0'],  // All segments
  diff: ['R2.0'],                      // Only cart changed
  segments: [ResolvedSegment<R2.0>],   // Full object for R2.0 only
}
```

### HMR Recovery Strategy

**Problem:** React Refresh clears `storedSegments` Map

**Detection:**
```typescript
const fullSegments = matched.map(id => storedSegments.get(id));
if (fullSegments.some(s => !s)) {
  // Missing segments detected!
}
```

**Solution:**
```typescript
// Refetch with empty segments = "I have nothing, send everything"
fetchPartialUpdate(url, []); // segmentIds = []

// Server sees empty _rsc_segments, treats as fresh client
// Returns all segments in diff
```

**NOT:**
```typescript
window.location.href = url; // ❌ Full reload (bad UX)
```

### Action Context

Actions receive same context as handlers:

```typescript
type ServerActionFn = (
  ctx: HandlerContext<GenericParams, AppEnv>,
  ...args: any[]
) => Promise<void> | void;
```

**Example:**
```typescript
export async function addToCart(ctx: HandlerContext, productId: string) {
  const user = ctx.get('user'); // Access middleware-set user
  const db = ctx.env.DB;        // Access bindings

  await db.cart.add({ userId: user.id, productId });
}
```

---

## Files to Create/Modify

### New Files:
1. `examples/vite-rsc-demo/src/actions/shop.actions.ts` - Example actions

### Modified Files:
1. `examples/vite-rsc-demo/src/entry.rsc.tsx` - Action detection & execution
2. `examples/vite-rsc-demo/src/entry.browser.tsx` - setServerCallback (DONE: HMR fix ✅)
3. `examples/vite-rsc-demo/src/handlers/shop.tsx` - Use actions in components

---

## Testing Checklist

- [ ] Action executes on button click
- [ ] Middleware runs before action
- [ ] Revalidation triggers after action
- [ ] Segments update correctly
- [ ] HMR recovery works (no full reload)
- [ ] matched updates currentSegmentIds
- [ ] Form submission works (progressive enhancement)
- [ ] Error handling works
- [ ] Production errors sanitized

---

## Next Steps

1. ✅ Fix HMR refetch (DONE)
2. Add action detection in entry.rsc.tsx
3. Implement action execution with middleware
4. Setup setServerCallback
5. Create example actions
6. Test full flow

---

## Notes

- Actions don't need return values if they just mutate and revalidate
- If actions need to return data, use form state pattern
- Middleware can block actions same as routes (return Response)
- Revalidation after actions uses existing soft/hard pattern
- Security: sanitizeError applies to action errors too

---

Last Updated: 2025-11-14
Ready for implementation: YES ✅
