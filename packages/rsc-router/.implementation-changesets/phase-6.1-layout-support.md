# Phase 6.1: Single Layout Support with route.layout (Verification)

**Status**: ✅ Completed (Verification Phase)
**Date**: 2025-11-09
**Time Spent**: ~10 minutes
**Approach**: Test-Driven Verification

---

## Objective

Verify that single layout support works via the route.layout symbol. Layouts should be stored and returned in match results for rendering.

---

## Verification Process

### Tests Written ✅
- Wrote 9 comprehensive layout tests
- Tests verify layout storage and retrieval

### All Tests Pass Immediately ✅
- **No code changes needed!**
- Layout support already works from Phase 3.4
- Symbol handling in handlers enables layouts
- Tests serve as verification and documentation

### Verification Complete ✅
- Single layout support confirmed working
- Ready for Phase 6.2 (layout arrays)

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/layout-support.test.tsx`
**Purpose**: Verification test suite for layout support
**Tests**: 9 tests across 7 describe blocks

**Test Coverage**:
1. **Single layout** (2 tests)
   - Layout accepted via symbol
   - Layout included in match result

2. **Layout with content** (1 test)
   - Layout and content both in handlers

3. **Without layout** (1 test)
   - Routes work without layout

4. **Nested routes** (1 test)
   - Layouts in nested handlers

5. **Multiple routes** (1 test)
   - Different layouts per route group

6. **Layout with middleware** (1 test)
   - Middleware executes before layout

7. **Function components** (2 tests)
   - Function component layouts
   - Arrow function layouts

---

### 2. Files Modified

**NONE** - Layout support already works!

From Phase 3.4, handlers are stored with symbols:
```typescript
router.route(routes).map({
  [route.layout]: MyLayout,  // ✅ Already supported!
  home: () => <HomePage />
});

// Stored in RegisteredRoute.handlers:
{
  [Symbol(route.layout)]: MyLayout,
  home: [Function]
}
```

---

## Test Results

### Test Execution
```bash
pnpm test
```

**Output**:
```
✓ src/__tests__/layout-support.test.tsx (9 tests) 4ms
... all other tests ...

Test Files  13 passed (13)
Tests  188 passed (188)
Duration  1.04s
```

**Status**: ✅ 100% passing (188/188 tests)

**LAYOUT SUPPORT VERIFIED** ✅

---

## API Specification

### Basic Layout Usage

```typescript
const router = createRSCRouter();
const routes = route({ home: '/', about: '/about' });

router.route(routes).map({
  [route.layout]: MyLayout,
  home: () => <HomePage />,
  about: () => <AboutPage />
});

// Match result includes layout
const result = await router.match(new Request('http://localhost/'));
// result.handlers[route.layout] === MyLayout
// result.handlers.home === [Function]
```

### Layout Component

```typescript
// Layout receives children via Outlet
function MyLayout() {
  return (
    <div className="layout">
      <header>Header</header>
      <main>
        <Outlet />  {/* Renders child content */}
      </main>
      <footer>Footer</footer>
    </div>
  );
}
```

### Without Layout

```typescript
router.route(routes).map({
  // No layout symbol - just content
  home: () => <HomePage />
});

// Works perfectly - layout is optional
```

### Nested Route Layouts

```typescript
const routes = route({
  blog: {
    index: '/blog',
    post: '/blog/:slug'
  }
});

router.route(routes).map({
  blog: {
    [route.layout]: BlogLayout,  // Layout for blog routes
    index: () => <BlogIndex />,
    post: () => <BlogPost />
  }
});
```

### Different Layouts per Route Group

```typescript
router.route(blogRoutes).map({
  [route.layout]: BlogLayout,
  ...blogHandlers
});

router.route(adminRoutes).map({
  [route.layout]: AdminLayout,
  ...adminHandlers
});

// Each route group has its own layout
```

---

## How It Works

### Storage (Phase 3.4)
```typescript
// When .map() is called:
addHandlersToRoute(index, handlers);

// Handlers object:
{
  [route.layout]: LayoutComponent,  // Symbol as key
  home: HomeHandler,
  about: AboutHandler
}

// Stored as-is in RegisteredRoute.handlers
```

### Retrieval (Phase 5.1)
```typescript
// When .match() finds a route:
return {
  matched: true,
  params: { ... },
  handlers: registered.handlers,  // Contains layout symbol!
  context: { ... }
};
```

### Usage (Application Code)
```typescript
const matchResult = await router.match(request);

if (matchResult) {
  const layout = matchResult.handlers[route.layout];
  const handler = matchResult.handlers.home;

  // Render with layout (if present)
  if (layout) {
    return <Layout><Handler /></Layout>;
  } else {
    return <Handler />;
  }
}
```

---

## Design Doc Compliance

From the design doc:

> **Single Layout**: `[route.layout]: BlogLayout` - Simple single layout wrapper

✅ **VERIFIED** - Works exactly as specified!

> **Outlet Usage**: Every layout uses `<Outlet />` to render its child content

✅ **SUPPORTED** - Outlet component from existing code

---

## Why It Already Works

The architecture from Phase 3.4 is **symbol-aware**:

1. **Symbols are valid object keys** in JavaScript
2. **Handler storage uses `any`** type - accepts symbols
3. **Symbol preservation** - Stored and retrieved correctly
4. **No special handling needed** - Symbols work like any other key

**Result**: Layout support "just works"! 🎉

---

## Success Criteria

- [x] Layout symbol accepted in .map()
- [x] Layout stored in handlers
- [x] Layout returned in match result
- [x] Works with nested routes
- [x] Works with different layouts per group
- [x] Works without layout (optional)
- [x] Middleware executes before layout
- [x] Function components supported
- [x] 9 verification tests
- [x] All 188 tests passing (100%)
- [x] No code changes needed
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── create-router.ts                          # Existing (already supports layouts!)
├── linear-matcher.ts                         # Existing
├── route-definition.ts                       # Existing (route.layout symbol)
├── __tests__/
│   ├── layout-support.test.tsx               # NEW: 9 verification tests
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

**Phase 6.2**: Implement Layout Arrays
- Support `[route.layout]: [Layout1, Layout2, Layout3]`
- Nested layouts (outer to inner)
- Each layout's `<Outlet />` renders the next

---

## Notes

- Layout support works out of the box
- Symbol-based architecture pays off
- No special code needed
- Tests verify and document behavior
- Ready for layout arrays (Phase 6.2)
- All quality checks passing

---

## Working Example

```typescript
import { createRSCRouter, route } from 'rsc-router';

const router = createRSCRouter();

function AppLayout() {
  return (
    <html>
      <body>
        <Outlet />  {/* Renders page content */}
      </body>
    </html>
  );
}

router.route(route({ home: '/', about: '/about' })).map({
  [route.layout]: AppLayout,
  home: () => <HomePage />,
  about: () => <AboutPage />
});

// Match and render
const result = await router.match(request);
const Layout = result.handlers[route.layout];
const Handler = result.handlers.home;

// Render: <AppLayout><HomePage /></AppLayout>
```

**Layout support: WORKING! ✅**
