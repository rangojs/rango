# Intercepting Routes - API Design & Redesign Proposal

## Current API (Keep This)

The API we designed is clean and follows Next.js patterns:

```typescript
intercept(slotName, routeName, handler, use?)
```

### Usage Example

```typescript
layout(<KanbanLayout />, () => [
  // Intercept card route - renders in @modal slot during soft navigation
  intercept("@modal", "card", <CardModal />, () => [
    loader(CardDetailLoader),
    revalidate(() => false),
  ]),
])

route("card", <CardDetailPage />)  // Hard navigation renders this
```

### In Layout

```tsx
function KanbanLayout() {
  return (
    <div>
      <KanbanBoard />
      <Outlet name="@modal" />  {/* Intercept content renders here */}
      <Outlet />                 {/* Normal route content */}
    </div>
  );
}
```

### Type Definition (Keep)

```typescript
intercept: <K extends keyof ResolvedRouteMap<T> & string>(
  slotName: `@${string}`,
  routeName: K,
  handler: ReactNode | Handler<ExtractRouteParams<T, K>, TEnv>,
  use?: () => InterceptUseItem[]
) => InterceptItem;
```

---

## Current Implementation Problems

The browser-side implementation is unstable because:

### 1. Browser-Side Segment Merging
```typescript
// partial-update.ts - Complex merge logic
if (isIntercept) {
  const existingSegments = Array.from(currentSegmentMap.values());
  const mergedMap = new Map<string, ResolvedSegment>();
  existingSegments.forEach(s => mergedMap.set(s.id, s));
  newSegments?.forEach((s) => mergedMap.set(s.id, s));
  fullSegments = Array.from(mergedMap.values());
}
```

**Problem**: Browser needs to know about intercepts and merge segments manually.

### 2. isIntercept Flag Threading
The `isIntercept` flag flows through:
- `router.ts` (server)
- `entry.rsc.tsx` (response metadata)
- `partial-update.ts` (browser)
- `server-action-bridge.ts` (actions)

**Problem**: Special-casing intercepts at every layer.

### 3. Modal Removal Detection
```typescript
// Detecting when to remove @modal
const currentHasModal = currentIds.some(id => id.includes("@modal"));
const matchedHasModal = matchedIds.some(id => id.includes("@modal"));
const needsModalRemoval = currentHasModal && !matchedHasModal;
```

**Problem**: String matching on segment IDs to detect modal state.

### 4. Cache/HMR Edge Cases
- Cross-tab refresh with empty cache
- HMR invalidating cached segments
- Actions during intercept needing segment merge

---

## How Next.js Does It

Next.js intercepting routes work by:

1. **Slots are parallel routes** - `@modal` is just a parallel route slot
2. **Server decides what renders** - Based on navigation type + route match
3. **Browser is dumb** - Just renders whatever slots the server sends
4. **No special browser merge logic** - Server sends complete slot state

### Key Insight

In Next.js, the `@modal` folder contains the intercepted route:
```
app/
  @modal/
    (.)photo/[id]/page.tsx   # Soft nav renders this
  photo/[id]/page.tsx         # Hard nav renders this
```

The slot `@modal` is **always** part of the layout. It just renders `null` when there's no intercept match.

---

## Proposed Redesign

### Core Principle: Slots Are First-Class

Instead of "intercepting" being a special case, make named slots (`@modal`, `@sidebar`, etc.) always present in the segment tree. The server determines their content.

### Server-Side Changes

#### 1. Intercepts Register as Conditional Slot Matchers

```typescript
// When registering intercept
intercept("@modal", "products.detail.view", handler, use)

// Creates a slot matcher:
{
  slotName: "@modal",
  matchesRoute: "products.detail.view",
  matchCondition: "soft-navigation-only",  // or could be expanded
  handler,
  loaders,
  etc.
}
```

#### 2. Route Matching Returns Slot State

```typescript
// Server route match result
{
  matched: ["$root", "$layout.shop", "$route.products"],
  slots: {
    "@modal": {
      active: true,  // or false for hard nav
      segments: [/* modal segments if active */]
    }
  },
  diff: [...],
}
```

#### 3. Server Always Sends Complete Slot State

For **soft navigation** to `/shop/product/123`:
```typescript
{
  matched: ["$root", "$layout.shop", "$route.index"],  // Background stays
  slots: {
    "@modal": {
      active: true,
      segments: ["$intercept.modal", "$loader.product"]
    }
  }
}
```

For **hard navigation** to `/shop/product/123`:
```typescript
{
  matched: ["$root", "$layout.shop", "$route.product"],
  slots: {
    "@modal": { active: false }  // No intercept on hard nav
  }
}
```

For **navigation away** from intercept:
```typescript
{
  matched: ["$root", "$layout.shop", "$route.index"],
  slots: {
    "@modal": { active: false }  // Clear the slot
  }
}
```

### Browser-Side Changes

#### 1. Remove All Intercept Special-Casing

```typescript
// partial-update.ts becomes simple:
function fetchPartialUpdate(...) {
  const { segments, slots } = payload.metadata;

  // Build full tree from segments + slot state
  // No merge logic - server tells us exactly what to render
  const fullSegments = buildSegmentsWithSlots(segments, slots);

  tx.commit(fullSegments);
  onUpdate({ root: await renderSegments(fullSegments) });
}
```

#### 2. Outlet Renders Slot State

```tsx
// Outlet component
function Outlet({ name }: { name?: string }) {
  const slots = useSlots();

  if (name) {
    // Named slot - render slot content or null
    const slot = slots[name];
    return slot?.active ? slot.content : null;
  }

  // Default outlet - render children
  return children;
}
```

### Detection: Soft vs Hard Navigation

The server needs to know if this is soft navigation (has referrer from same origin + has cached segments) vs hard navigation (direct URL access).

```typescript
// Server-side detection
function isSoftNavigation(request: Request, segmentIds: string[]): boolean {
  // Has X-RSC-Segments header = client-side navigation
  return segmentIds.length > 0;
}
```

---

## Implementation Steps

### Phase 1: Server Refactor

1. Add `slots` to route match result type
2. Modify `matchRoute` to return slot state based on:
   - Is this soft navigation? (has segments header)
   - Does an intercept match the target route?
3. Include slot segments in response metadata

### Phase 2: Browser Simplification

1. Remove `isIntercept` flag handling
2. Remove segment merge logic
3. Add slot state to segment rendering
4. Update `<Outlet name="@modal" />` to use slot state

### Phase 3: Action Handling

1. Actions return slot state same as navigation
2. Remove action-specific intercept merge logic

---

## Benefits of Redesign

| Current | Proposed |
|---------|----------|
| Browser merges segments | Server sends complete state |
| `isIntercept` flag everywhere | No special flags |
| String matching for modal detection | Explicit slot state |
| Complex HMR/cache edge cases | Server is source of truth |
| Hard to debug | Clear data flow |

---

## Questions to Resolve

1. **Back navigation**: How does browser know to restore previous slot state?
   - Option A: Cache slot state per history entry
   - Option B: Server re-evaluates on back nav

2. **Multiple intercepts**: Can multiple slots be active simultaneously?
   - Probably yes - each slot is independent

3. **Nested intercepts**: Can an intercept have its own slots?
   - Probably defer this complexity

---

## References

- [Next.js Intercepting Routes](https://nextjs.org/docs/app/building-your-application/routing/intercepting-routes)
- [Next.js Parallel Routes](https://nextjs.org/docs/app/building-your-application/routing/parallel-routes)
- [Builder.io: Next.js 14 Intercepting Routes](https://www.builder.io/blog/nextjs-14-intercepting-routes)
