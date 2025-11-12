# Phase 8.1: Parallel Route Slot Distribution

**Status**: ✅ Complete  
**Date**: 2025-11-09  
**Test Count**: 13 tests (all passing)  
**Total Tests**: 492 tests (100% passing)

---

## Objective

Implement parallel route slot extraction and distribution. This phase completes the parallel routes feature by properly extracting @slots from handlers and ensuring they're correctly built into the segment map.

Key features:
- Extract parallel slots from [route.parallel] symbol
- Support global and per-route parallel routes
- Merge global and per-route slots (per-route overrides on conflict)
- Proper @ prefix enforcement
- Sequential P segment indices

---

## Implementation

### Functions Added

**extractParallelSlots()** - Extracts parallel route slots from handlers
- Supports global parallel routes ([route.parallel] at top level)
- Supports per-route parallel routes (nested under route name)
- Merges global and per-route (per-route overrides conflicts)
- Returns object with @ prefixed keys

### Types Added

**ParallelSlots** - Type-safe slot definition
```typescript
type ParallelSlots = Record<`@${string}`, ReactNode>;
```

### Functions Enhanced

**buildSegmentMap()** - Fixed to use route.parallel symbol
- Changed from `handlers.parallel` to `handlers[route.parallel]`
- Changed from `handlers.layout` to `handlers[route.layout]`
- Ensures symbol-based access throughout

---

## Test Coverage

**13 comprehensive tests** across 3 suites:

### extractParallelSlots() (8 tests)
- ✅ Global parallel routes (single, multiple, none, @ prefix)
- ✅ Per-route parallel routes (extract, multiple, override, merge)

### buildSegmentMap() with parallel routes (4 tests)
- ✅ Creates P segments for parallel routes
- ✅ Assigns sequential indices
- ✅ Preserves parallel route order
- ✅ Passes params to parallel segments

### Integration (1 test)
- ✅ Includes parallel segments in full segment map

---

## Usage

```typescript
// Define parallel routes
const handlers = {
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@modal': () => <Modal />
  },
  index: () => <Dashboard />
};

// Extract slots
const slots = extractParallelSlots(handlers);
// { '@sidebar': Sidebar, '@modal': Modal }

// Build segment map
const segments = buildSegmentMap({ pathname, params, handlers });
// [R0, P1, P2] where P1=@sidebar, P2=@modal
```

---

## Parallel Routes: Additive Rendering Behavior

**IMPORTANT**: Parallel routes are **ADDITIVE** - they render **alongside** the main route content, not replacing it.

### Rendering Behavior

```typescript
// Given handlers:
const handlers = {
  index: () => <MainContent />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@modal': () => <Modal />
  }
};

// Renders as:
<>
  <MainContent />      {/* Main route content */}
  <Sidebar />          {/* @sidebar parallel route */}
  <Modal />            {/* @modal parallel route */}
</>
```

### Merging Rules

**Same slot name** - Per-route overrides:
```typescript
const handlers = {
  [route.parallel]: {
    '@sidebar': GlobalSidebar  // Global
  },
  dashboard: {
    [route.parallel]: {
      '@sidebar': DashboardSidebar  // Per-route - THIS ONE WINS
    }
  }
};
// Result: DashboardSidebar renders (per-route overrides global)
```

**Different slot names** - Both render:
```typescript
const handlers = {
  [route.parallel]: {
    '@sidebar': GlobalSidebar  // From global
  },
  dashboard: {
    [route.parallel]: {
      '@notifications': Notifications  // From per-route
    }
  }
};
// Result: BOTH render - GlobalSidebar + Notifications
```

### In Code

The implementation in `reconstructTreeFromSegments()` and `renderSegments()`:

```typescript
// 1. Render route content
let content = <RouteComponent />;

// 2. Add parallel routes alongside (ADDITIVE!)
if (parallelSegments.length > 0) {
  const parallelNodes = parallelSegments.map(segment =>
    <ParallelComponent key={segment.id} />
  );

  // Combine main content WITH parallel routes
  content = <>{content}{...parallelNodes}</>;
}

// 3. Wrap with layouts
// Layout wraps the combined content (route + parallel routes)
```

**Key Point**: The main route handler and parallel routes all render together. Parallel routes don't replace the main content - they're siblings.

---

## Design Decisions

### 1. Merge with Override

**Decision**: Per-route slots override global slots with same name

**Rationale**:
- More specific configuration wins
- Allows route-specific slot implementations
- Maintains global fallback for common slots
- Standard pattern in configuration systems

### 2. Insertion Order Preservation

**Decision**: Use Object.keys() and preserve insertion order

**Rationale**:
- ES2015+ guarantees insertion order for string keys
- Predictable rendering order
- No need for additional sorting
- Matches user expectations

### 3. Symbol-Based Access

**Decision**: Use route.parallel and route.layout symbols

**Rationale**:
- Type-safe with symbol exports
- No string key collisions
- Clear separation from route names
- Matches design throughout codebase

---

## Files Changed

### Created
- `src/__tests__/parallel-slot-distribution.test.tsx` (13 tests)

### Modified
- `src/segment-system.ts`
  - Added ParallelSlots type
  - Added extractParallelSlots() function (+70 lines)
  - Fixed buildSegmentMap() to use symbols
- `src/__tests__/segment-map-building.test.tsx`
  - Updated to use route.layout and route.parallel symbols

---

## Test Results

```
✓ Phase 8.1: 13/13 tests passing
✓ Total: 492/492 tests passing (100%)
```

---

## Success Criteria

- [x] ParallelSlots type defined
- [x] extractParallelSlots() implemented
- [x] Global parallel routes supported
- [x] Per-route parallel routes supported
- [x] Merge with override pattern works
- [x] buildSegmentMap() uses symbols
- [x] @ prefix enforced
- [x] All tests pass (492 total)

---

## Next Steps

**Phase 8.1.1**: Example Application (NEXT)
- Create example app demonstrating partial rendering
- Show parallel routes in action
- Demonstrate navigation flow

**Phase 8.2**: Enhanced Revalidation Logic
- Layout persistence
- Smart param comparison

**Phase 9.2**: E2E Integration Tests

---

## Status

✅ **PARALLEL ROUTES COMPLETE!**

**Next**: Example app to demonstrate the router in action

---

**Generated**: 2025-11-09  
**Phase**: 8.1 of 35  
**Completion**: 34/35 phases (97%)
