# Phase 3.4: Implement RouteBuilder.map() Method - Basic Handler Mapping

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~25 minutes
**Approach**: Test-Driven Development (TDD)

---

## Objective

Implement handler mapping via RouteBuilder.map() method. This completes the route registration flow, connecting route definitions to their handler functions.

---

## TDD Process

### Red Phase ✅
- Wrote 17 comprehensive tests for handler mapping
- Tests initially failed (handlers property missing, map() was stub)

### Green Phase ✅
- Added handlers property to RegisteredRoute
- Implemented map() method in RouteBuilder
- Added addHandlersToRoute() to RSCRouter
- All 113 tests passing (96 previous + 17 new)

### Refactor Phase ✅
- Verified code quality
- No new errors

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/route-builder-map.test.tsx`
**Purpose**: Test suite for handler mapping
**Tests**: 17 tests across 7 describe blocks

**Test Coverage**:
1. **Basic handler mapping** (3 tests)
   - Simple route handlers
   - Returns router for chaining
   - Multiple route groups

2. **Handler storage** (2 tests)
   - Handlers stored in registered route
   - Separate storage per route group

3. **Nested route handlers** (3 tests)
   - Nested route handlers
   - Deeply nested handlers
   - Mixed flat and nested

4. **Handlers with symbols** (3 tests)
   - route.layout symbol
   - route.parallel symbol
   - Multiple symbols together

5. **Handler context** (2 tests)
   - Handlers with context parameter
   - Async handlers

6. **Handler variations** (2 tests)
   - Direct handler objects
   - Various return types

7. **Return value and chaining** (2 tests)
   - Returns router
   - Chaining multiple registrations

---

### 2. Files Modified

#### `packages/rsc-router/src/create-router.ts`

**RegisteredRoute Interface Updated**:
```typescript
export interface RegisteredRoute {
  routes: ResolvedRouteMap<any>;
  prefix?: string;
  middleware: Middleware[];
  handlers?: any;  // NEW: Handler object storage
}
```

**RouteBuilder.map() Implemented**:
```typescript
map(handlers: any): RSCRouter {
  // Store handlers in the registered route
  this.router.addHandlersToRoute(this.registrationIndex, handlers);
  return this.router;  // Return router for chaining
}
```

**New Helper Method**:
```typescript
addHandlersToRoute(index: number, handlers: any): void {
  const route = this.registeredRoutes[index];
  if (route) {
    route.handlers = handlers;
  }
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
✓ src/__tests__/route-definition.test.ts (18 tests) 4ms
✓ src/__tests__/create-router.test.tsx (18 tests) 4ms
✓ src/__tests__/route-symbols.test.tsx (15 tests) 5ms
✓ src/__tests__/route-nested.test.ts (14 tests) 4ms
✓ src/__tests__/route-mounting.test.tsx (13 tests) 4ms
✓ src/__tests__/route-builder-map.test.tsx (17 tests) 5ms
✓ src/__tests__/route-builder-middleware.test.tsx (15 tests) 6ms
✓ src/__tests__/sanity.test.ts (3 tests) 1ms

Test Files  8 passed (8)
Tests  113 passed (113)
Duration  879ms
```

**Status**: ✅ 100% passing (113/113 tests)

### Type Safety
```bash
pnpm type-check
```

**New code**: ✅ No new TypeScript errors
**Expected warnings**: Unused _routeMap and _prefix (will be used in matcher phases)

### Linting
**New code**: ✅ No lint errors (one expected `any` warning in handler type)

---

## API Specification

### Basic Handler Mapping

```typescript
const router = createRSCRouter();
const routes = route({
  home: '/',
  about: '/about',
  user: '/users/:id'
});

router.route(routes).map({
  home: () => <HomePage />,
  about: () => <AboutPage />,
  user: (ctx) => <UserPage id={ctx.params.id} />
});
```

### With Symbols

```typescript
router.route(routes).map({
  [route.layout]: MyLayout,
  [route.loading]: LoadingSpinner,
  [route.error]: ErrorBoundary,
  [route.parallel]: {
    '@sidebar': Sidebar,
    '@modal': Modal
  },
  home: () => <HomePage />
});
```

### Nested Handlers

```typescript
const routes = route({
  blog: {
    index: '/blog',
    post: '/blog/:slug'
  }
});

router.route(routes).map({
  blog: {
    [route.layout]: BlogLayout,
    index: () => <BlogIndex />,
    post: (ctx) => <BlogPost slug={ctx.params.slug} />
  }
});
```

### Complete Flow

```typescript
const router = createRSCRouter();

router
  .use(logger())               // Global middleware
  .use(cors())                 // Global middleware
  .route('/blog', blogRoutes)  // Register routes
  .use(blogAuth())             // Route-specific middleware
  .map({                       // Map handlers
    [route.layout]: BlogLayout,
    index: () => <BlogIndex />,
    post: () => <BlogPost />
  })
  .route('/admin', adminRoutes)
  .use(adminAuth())
  .use(adminAudit())
  .map(adminHandlers);
```

---

## Design Decisions

### 1. Simple Handler Storage
Handlers stored as-is in RegisteredRoute:

```typescript
interface RegisteredRoute {
  handlers?: any;  // Flexible handler object
}
```

**Rationale**:
- Supports any handler structure
- Works with symbols
- Works with nested handlers
- Simple implementation
- Type safety enforced at call site, not storage

### 2. Index-Based Update
Uses registrationIndex like middleware:

**Rationale**:
- Consistent with use() implementation
- O(1) access
- Clean separation of concerns
- RouteBuilder stays lightweight

### 3. Returns Router (not Builder)
map() returns router, not builder:

```typescript
map(handlers): RSCRouter {
  // ...
  return this.router;  // Not 'this'
}
```

**Rationale**:
- map() completes route registration
- No further builder operations expected
- Allows chaining to next route group
- Matches design doc API

### 4. Handler Type is `any`
Intentionally flexible for Phase 3.4:

**Rationale**:
- Handlers can be functions, objects, symbols, lazy imports
- Type safety comes from route.map() generic constraints (future)
- Keeps implementation simple for basic phase
- Can add strict typing later

---

## Implementation Highlights

### Handler Storage
```typescript
addHandlersToRoute(index: number, handlers: any): void {
  const route = this.registeredRoutes[index];
  if (route) {
    route.handlers = handlers;  // Simple assignment
  }
}
```

**Safety**: Checks route exists before updating

### map() Method
```typescript
map(handlers: any): RSCRouter {
  this.router.addHandlersToRoute(this.registrationIndex, handlers);
  return this.router;  // Chain to router, not builder
}
```

**Flow**: Builder → Store handlers → Return router

---

## Complete Registration Flow

```typescript
const router = createRSCRouter();

// Step 1: router.route() creates builder + stores route
const builder = router.route('/blog', blogRoutes);

// Step 2: builder.use() adds middleware to route
builder.use(authMiddleware);

// Step 3: builder.map() adds handlers to route
builder.map(blogHandlers);  // Returns router

// Final state:
router.getRegisteredRoutes()[0] === {
  routes: blogRoutes,
  prefix: '/blog',
  middleware: [authMiddleware],
  handlers: blogHandlers
};
```

---

## Examples from Tests

### Example 1: Simple Handlers
```typescript
const routes = route({ home: '/', about: '/about' });

router.route(routes).map({
  home: () => <HomePage />,
  about: () => <AboutPage />
});

router.getRegisteredRoutes()[0].handlers;
// { home: [Function], about: [Function] }
```

### Example 2: With Symbols
```typescript
router.route(routes).map({
  [route.layout]: Layout,
  [route.loading]: Loading,
  home: () => <HomePage />
});

router.getRegisteredRoutes()[0].handlers;
// {
//   [Symbol(route.layout)]: Layout,
//   [Symbol(route.loading)]: Loading,
//   home: [Function]
// }
```

### Example 3: Nested Handlers
```typescript
const routes = route({
  blog: {
    index: '/blog',
    post: '/blog/:slug'
  }
});

router.route(routes).map({
  blog: {
    index: () => <BlogIndex />,
    post: () => <BlogPost />
  }
});

router.getRegisteredRoutes()[0].handlers;
// {
//   blog: {
//     index: [Function],
//     post: [Function]
//   }
// }
```

### Example 4: Complete Flow
```typescript
router
  .use(logger())
  .route('/blog', blogRoutes)
  .use(blogAuth())
  .map({
    [route.layout]: BlogLayout,
    index: () => <BlogIndex />,
    post: () => <BlogPost />
  })
  .route('/admin', adminRoutes)
  .use(adminAuth())
  .map(adminHandlers);

// Two registered routes with complete config
```

---

## Handler Types Supported

From tests, the following work:

1. **Sync functions**: `() => <Component />`
2. **Async functions**: `async () => <Component />`
3. **With context**: `(ctx) => <Component data={ctx.params.id} />`
4. **With symbols**: `{ [route.layout]: Layout }`
5. **Nested objects**: `{ blog: { index: () => ... } }`
6. **Response objects**: `() => Response.json({ data })`

---

## Breaking Changes

None! Completes the fluent API:

```typescript
// Complete API now available
router
  .use(globalMiddleware)       // Phase 3.1
  .route(prefix, routes)        // Phase 3.2
  .use(routeMiddleware)         // Phase 3.3
  .map(handlers);               // Phase 3.4 ✅
```

---

## Success Criteria

- [x] map() method implemented
- [x] Handler storage in RegisteredRoute
- [x] addHandlersToRoute() helper
- [x] Returns router for chaining
- [x] Symbol support verified
- [x] Nested handler support
- [x] Handler isolation per route group
- [x] 17 comprehensive tests
- [x] All 113 tests passing (100%)
- [x] No new TypeScript errors
- [x] Minimal lint warnings
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── create-router.ts                          # Updated: handler mapping
├── route-definition.ts                       # Existing
├── __tests__/
│   ├── route-builder-map.test.tsx            # NEW: 17 tests
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

**Phase 4.1**: Implement Linear Pattern Matcher
- Core matching algorithm
- Static route matching
- Dynamic segment matching
- Hono-inspired linear scan

This is where routes come alive! 🚀

---

## Notes

- Complete fluent API now functional
- Handler storage is simple and flexible
- Symbol support verified
- Nested handlers work perfectly
- Ready for matcher implementation (Phase 4.1)
- All quality checks passing
