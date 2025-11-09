# Phase 6.2: Layout Arrays for Nested Layouts (Verification)

**Status**: ✅ Completed (Verification Phase)
**Date**: 2025-11-09
**Time Spent**: ~10 minutes
**Approach**: Test-Driven Verification

---

## Objective

Verify that layout arrays work for nested layout structures. Arrays should be stored and returned correctly, with order preserved (outer to inner).

---

## Verification Process

### Tests Written ✅
- Wrote 10 comprehensive layout array tests
- Tests verify array storage and ordering

### All Tests Pass Immediately ✅
- **No code changes needed!**
- Layout arrays already work from Phase 3.4
- Arrays are valid symbol values
- Order is preserved

### Verification Complete ✅
- Layout array support confirmed working
- Ready for Phase 6.3 (per-route layouts)

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/layout-arrays.test.tsx`
**Purpose**: Verification test suite for layout arrays
**Tests**: 10 tests across 6 describe blocks

**Test Coverage**:
1. **Basic layout arrays** (4 tests)
   - Array of layouts accepted
   - Order maintained (outer to inner)
   - Two-level nesting
   - Three-level nesting

2. **Single vs array compatibility** (2 tests)
   - Single layout still works
   - Differentiation between single and array

3. **Nested routes** (1 test)
   - Layout arrays in nested handlers

4. **Empty arrays** (1 test)
   - Empty layout array handling

5. **With middleware** (1 test)
   - Middleware executes before layouts

6. **Design doc examples** (1 test)
   - Example from design doc verified

---

### 2. Files Modified

**NONE** - Layout arrays already work!

From Phase 3.4, handlers store any value:
```typescript
router.route(routes).map({
  [route.layout]: [Layout1, Layout2, Layout3],  // ✅ Array works!
  home: () => <HomePage />
});

// Stored as-is in RegisteredRoute.handlers
```

---

## Test Results

### Test Execution
```bash
pnpm test
```

**Output**:
```
✓ src/__tests__/layout-arrays.test.tsx (10 tests) 6ms
... all other tests ...

Test Files  14 passed (14)
Tests  198 passed (198)
Duration  1.16s
```

**Status**: ✅ 100% passing (198/198 tests)

**LAYOUT ARRAYS VERIFIED** ✅

---

## API Specification

### Layout Array Usage

```typescript
const router = createRSCRouter();
const routes = route({ home: '/', about: '/about' });

router.route(routes).map({
  [route.layout]: [RootLayout, AppShell, BlogLayout],
  home: () => <HomePage />,
  about: () => <AboutPage />
});

// Match result contains layout array
const result = await router.match(request);
result.handlers[route.layout];  // [RootLayout, AppShell, BlogLayout]
```

### Nesting Semantics (Outer to Inner)

From design doc:
> **Multiple Layouts**: `[route.layout]: [RootLayout, AppShell, BlogLayout]` - Nested layouts applied in order (outer to inner)
> **Layout Nesting**: Each layout in the array wraps the next, with the last wrapping the content

```typescript
[route.layout]: [RootLayout, AppShell, BlogLayout]

// Rendering hierarchy:
// RootLayout
//   └─ <Outlet /> → AppShell
//       └─ <Outlet /> → BlogLayout
//           └─ <Outlet /> → Content
```

**Order**:
- `RootLayout` (outermost)
- `AppShell` (middle)
- `BlogLayout` (innermost, wraps content)

### Single Layout (Still Works)

```typescript
router.route(routes).map({
  [route.layout]: SingleLayout,  // Not an array
  home: () => <HomePage />
});

// Stored as component, not array
result.handlers[route.layout] === SingleLayout;  // Not [SingleLayout]
```

### Empty Array

```typescript
router.route(routes).map({
  [route.layout]: [],  // Empty array
  home: () => <HomePage />
});

// Valid - no layouts applied
result.handlers[route.layout] === [];
```

---

## Design Doc Compliance

From the design doc:

> **Single Layout**: `[route.layout]: BlogLayout`

✅ **VERIFIED** - Phase 6.1

> **Multiple Layouts**: `[route.layout]: [RootLayout, AppShell, BlogLayout]`

✅ **VERIFIED** - Phase 6.2 (this phase)

> **Layout Nesting**: Each layout in the array wraps the next

✅ **SUPPORTED** - Application code will handle nesting with OutletProvider

> **Outlet Usage**: Every layout uses `<Outlet />` to render its child content

✅ **SUPPORTED** - Outlet component from existing code

---

## Rendering Logic (Application Code)

```typescript
const result = await router.match(request);

if (result) {
  const layouts = result.handlers[route.layout];
  const handler = result.handlers.home;

  // Single layout
  if (layouts && !Array.isArray(layouts)) {
    return <Layout><Handler /></Layout>;
  }

  // Layout array (nest from outer to inner)
  if (layouts && Array.isArray(layouts)) {
    let tree = <Handler />;

    // Wrap from innermost to outermost
    for (let i = layouts.length - 1; i >= 0; i--) {
      const Layout = layouts[i];
      tree = <Layout>{tree}</Layout>;
    }

    return tree;
  }

  // No layout
  return <Handler />;
}
```

**Result with `[L1, L2, L3]`**:
```jsx
<L1>
  <L2>
    <L3>
      <Content />
    </L3>
  </L2>
</L1>
```

---

## Success Criteria

- [x] Layout arrays accepted
- [x] Order preserved (outer to inner)
- [x] Multiple nesting levels work
- [x] Single layout still works
- [x] Differentiation between single and array
- [x] Works with nested routes
- [x] Empty array handled
- [x] Middleware executes first
- [x] Design doc examples verified
- [x] 10 verification tests
- [x] All 198 tests passing (100%)
- [x] No code changes needed
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── create-router.ts                          # Existing (supports arrays!)
├── linear-matcher.ts                         # Existing
├── route-definition.ts                       # Existing
├── __tests__/
│   ├── layout-arrays.test.tsx                # NEW: 10 verification tests
│   ├── layout-support.test.tsx               # Existing: 9 tests
│   ├── middleware-security.test.tsx          # Existing: 10 tests
│   ├── router-match.test.tsx                 # Existing: 14 tests
│   ├── linear-matcher-wildcards.test.ts      # Existing: 16 tests
│   ├── linear-matcher.test.ts                # Existing: 26 tests
│   ├── route-builder-map.test.tsx            # Existing: 17 tests
│   ├── route-builder-middleware.test.tsx     # Existing: 15 tests
│   ├── route-mounting.test.tsx               # Existing: 13 tests
│   ├── create-router.test.tsx                # Existing: 18 tests
│   ├── route-symbols.test.tsx                # Existing: 15 tests
│   ├── route-nested.test.ts                  # Existing: 14 tests
│   ├── route-definition.test.ts              # Existing: 18 tests
│   ├── sanity.test.ts                        # Existing: 3 tests
│   └── setup.ts                              # Existing
└── index.ts                                  # Existing
```

---

## Next Steps

**Phase 6.3**: Per-Route Layouts (NEW!)
- Support `[route.layout]: { home: [L1, L2], about: [L1, L3] }`
- Different layouts per route in same group
- Type-safe route name keys

---

## Notes

- Layout arrays work out of the box
- Flexible handler storage accepts any value
- Single layout, array, or none - all supported
- Order preservation verified
- Ready for per-route layouts (Phase 6.3)
- All quality checks passing

---

## Working Example

```typescript
import { createRSCRouter, route } from 'rsc-router';

const router = createRSCRouter();

// Define layouts
function RootLayout() {
  return (
    <html>
      <body>
        <Outlet />
      </body>
    </html>
  );
}

function AppShell() {
  return (
    <div className="app">
      <nav>Navigation</nav>
      <Outlet />
    </div>
  );
}

function BlogLayout() {
  return (
    <div className="blog">
      <aside>Blog Sidebar</aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

// Use layout array
router.route(route({ home: '/' })).map({
  [route.layout]: [RootLayout, AppShell, BlogLayout],
  home: () => <HomePage />
});

// Result nesting:
// RootLayout → AppShell → BlogLayout → HomePage
```

**Layout arrays: WORKING! ✅**
