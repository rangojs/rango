# Phase 3.3: Implement RouteBuilder.use() Method for Middleware

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~20 minutes
**Approach**: Test-Driven Development (TDD)

---

## Objective

Implement route-specific middleware storage via RouteBuilder.use() method. Middleware added through RouteBuilder is scoped to that specific route group, separate from global middleware.

---

## TDD Process

### Red Phase ✅
- Wrote 15 comprehensive tests for route-specific middleware
- Tests initially failed (use() method was stub)

### Green Phase ✅
- Implemented middleware storage in RouteBuilder
- Added addMiddlewareToRoute() to RSCRouter
- Updated RouteBuilder constructor with registrationIndex
- All 96 tests passing (81 previous + 15 new)

### Refactor Phase ✅
- Verified code quality
- No new errors

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/route-builder-middleware.test.tsx`
**Purpose**: Test suite for route-specific middleware
**Tests**: 15 tests across 6 describe blocks

**Test Coverage**:
1. **Basic middleware storage** (4 tests)
   - Single middleware
   - Multiple middleware from single use()
   - Chained use() calls
   - Middleware order

2. **Middleware isolation** (2 tests)
   - Isolation between route groups
   - No interference with global middleware

3. **Chaining** (2 tests)
   - use() after route() with prefix
   - use() after route() without prefix

4. **Empty middleware** (2 tests)
   - Routes with no middleware
   - Empty use() call

5. **Different signatures** (3 tests)
   - Async middleware
   - Sync middleware
   - Mixed async/sync

6. **Return value** (2 tests)
   - Returns RouteBuilder for chaining
   - Same instance throughout chain

---

### 2. Files Modified

#### `packages/rsc-router/src/create-router.ts`

**RouteBuilder Updates**:

Added registrationIndex property:
```typescript
export class RouteBuilder {
  private registrationIndex: number;

  constructor(
    private router: RSCRouter,
    private _routeMap: ResolvedRouteMap<T>,
    registrationIndex: number,  // NEW parameter
    private _prefix?: string
  ) {
    this.registrationIndex = registrationIndex;
  }
}
```

Implemented use() method:
```typescript
use(...middleware: Middleware[]): this {
  this.router.addMiddlewareToRoute(this.registrationIndex, ...middleware);
  return this;  // For chaining
}
```

**RSCRouter Updates**:

Updated route() method:
```typescript
route(prefixOrRoutes, routeMap?) {
  // ... prefix/routes logic

  const registrationIndex = this.registeredRoutes.length;  // NEW
  this.registeredRoutes.push({
    routes,
    prefix,
    middleware: [],
  });

  const builder = new RouteBuilder(
    this,
    routes,
    registrationIndex,  // Pass index
    prefix
  );

  return builder;
}
```

Added addMiddlewareToRoute() method:
```typescript
addMiddlewareToRoute(index: number, ...middleware: Middleware[]): void {
  const route = this.registeredRoutes[index];
  if (route) {
    route.middleware.push(...middleware);
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
Test Files  7 passed (7)
Tests  96 passed (96)
Duration  531ms
```

**Status**: ✅ 100% passing (96/96 tests)

### Type Safety
```bash
pnpm type-check
```

**New code**: ✅ No new TypeScript errors
**Expected warnings**: Unused _routeMap and _prefix (for Phase 3.4)

### Linting
```bash
pnpm lint
```

**New code**: ✅ No lint errors or warnings

---

## API Specification

### Route-Specific Middleware

```typescript
const router = createRSCRouter();
const blogRoutes = route({ index: '/blog', post: '/blog/:slug' });

router
  .route('/blog', blogRoutes)
  .use(blogAuth())
  .use(blogTracking())
  .use(blogRateLimit())
  .map(blogHandlers);
```

### Middleware Isolation

```typescript
router
  .route('/blog', blogRoutes)
  .use(blogMiddleware)  // Only applies to /blog routes
  .map(blogHandlers)
  .route('/admin', adminRoutes)
  .use(adminAuth())  // Only applies to /admin routes
  .map(adminHandlers);
```

### Global + Route-Specific Middleware

```typescript
router
  .use(logger())      // Global: applies to ALL routes
  .use(cors())        // Global: applies to ALL routes
  .route('/blog', blogRoutes)
  .use(blogAuth())    // Scoped: only /blog routes
  .map(blogHandlers)
  .route('/admin', adminRoutes)
  .use(adminAuth())   // Scoped: only /admin routes
  .use(adminAudit())  // Scoped: only /admin routes
  .map(adminHandlers);

// Middleware execution order (Phase 5.1):
// /blog/* → logger → cors → blogAuth → handler
// /admin/* → logger → cors → adminAuth → adminAudit → handler
```

### Chaining Multiple use() Calls

```typescript
router
  .route(routes)
  .use(mw1)
  .use(mw2)
  .use(mw3)
  .map(handlers);

// Equivalent to:
router.route(routes).use(mw1, mw2, mw3).map(handlers);
```

---

## Design Decisions

### 1. Index-Based Storage
RouteBuilder stores its registration index:

**Rationale**:
- Direct access to registered route
- O(1) middleware updates
- No need to search for the route
- Simple and efficient

### 2. Pass-Through to Router
RouteBuilder.use() delegates to router.addMiddlewareToRoute():

**Rationale**:
- Single source of truth (registeredRoutes array)
- Builder is lightweight (no duplicate storage)
- Router manages all state
- Easy to inspect/debug

### 3. Array-Based Middleware Storage
Middleware stored as array in RegisteredRoute:

**Rationale**:
- Preserves execution order
- Easy to iterate during execution
- Can prepend global middleware easily
- Standard pattern

### 4. Return this for Chaining
use() returns `this` (the builder):

**Rationale**:
- Fluent API
- Natural chaining syntax
- Matches design doc
- Better DX

---

## Implementation Highlights

### Registration Index Tracking
```typescript
const registrationIndex = this.registeredRoutes.length;
this.registeredRoutes.push({ routes, prefix, middleware: [] });

// Pass index to builder
new RouteBuilder(this, routes, registrationIndex, prefix);
```

### Middleware Addition
```typescript
addMiddlewareToRoute(index: number, ...middleware: Middleware[]): void {
  const route = this.registeredRoutes[index];
  if (route) {
    route.middleware.push(...middleware);  // Append to array
  }
}
```

**Safety**: Checks if route exists before updating

---

## Examples from Tests

### Example 1: Basic Middleware
```typescript
const router = createRSCRouter();
const routes = route({ home: '/' });
const auth = async () => {};

router.route(routes).use(auth);

router.getRegisteredRoutes()[0].middleware;  // [auth]
```

### Example 2: Multiple Middleware
```typescript
router
  .route(routes)
  .use(auth, logger, rateLimit);

router.getRegisteredRoutes()[0].middleware;
// [auth, logger, rateLimit] - in order
```

### Example 3: Chained use()
```typescript
router
  .route(routes)
  .use(auth)
  .use(logger)
  .use(rateLimit);

router.getRegisteredRoutes()[0].middleware;
// [auth, logger, rateLimit]
```

### Example 4: Isolated Middleware
```typescript
router.route(blogRoutes).use(blogAuth);
router.route(adminRoutes).use(adminAuth);

router.getRegisteredRoutes();
// [
//   { routes: blogRoutes, middleware: [blogAuth] },
//   { routes: adminRoutes, middleware: [adminAuth] }
// ]
```

### Example 5: Global + Scoped
```typescript
router.use(globalLogger);  // Global

router.route(blogRoutes).use(blogAuth);  // Scoped to blog

router.getGlobalMiddleware();  // [globalLogger]
router.getRegisteredRoutes()[0].middleware;  // [blogAuth]
```

---

## Middleware Execution Order

**Will be implemented in Phase 5.1**, but the storage supports:

1. Global middleware (from router.use())
2. Route-specific middleware (from builder.use())
3. Execution order: Global first, then route-specific

```typescript
// Setup
router
  .use(global1)
  .use(global2)
  .route('/blog', blogRoutes)
  .use(blog1)
  .use(blog2)
  .map(handlers);

// Execution order for /blog/* requests:
// global1 → global2 → blog1 → blog2 → handler
```

---

## Breaking Changes

None! All previous API still works:
- router.use() - Still works (global middleware)
- router.route() - Still works (returns RouteBuilder)
- Now: builder.use() also works (route-specific middleware)

---

## Success Criteria

- [x] RouteBuilder.use() implemented
- [x] Middleware storage per route group
- [x] registrationIndex tracking
- [x] addMiddlewareToRoute() helper
- [x] Middleware isolation verified
- [x] Order preservation verified
- [x] Chaining works correctly
- [x] 15 comprehensive tests
- [x] All 96 tests passing (100%)
- [x] No new TypeScript errors
- [x] No lint issues
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── create-router.ts                          # Updated: middleware storage
├── route-definition.ts                       # Existing
├── __tests__/
│   ├── route-builder-middleware.test.tsx     # NEW: 15 tests
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

**Phase 3.4**: Implement RouteBuilder.map() method
- Map handlers to routes
- Type-safe handler validation
- Complete route registration flow

---

## Notes

- Middleware storage is clean and efficient
- Index-based access provides O(1) updates
- Isolation between route groups verified
- Ready for handler mapping (Phase 3.4)
- Ready for execution pipeline (Phase 5.1)
- All quality checks passing
