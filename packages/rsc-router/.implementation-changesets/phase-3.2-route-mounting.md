# Phase 3.2: Implement router.route() Method - Basic Mounting

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~20 minutes
**Approach**: Test-Driven Development (TDD)

---

## Objective

Implement internal route storage and path prefix normalization. Routes are stored when `.route()` is called, preparing them for handler mapping (Phase 3.4) and matching (Phase 4.1+).

---

## TDD Process

### Red Phase ✅
- Wrote 13 comprehensive tests for route mounting
- Tests initially failed (getRegisteredRoutes() method missing)

### Green Phase ✅
- Added RegisteredRoute interface
- Implemented route storage in registeredRoutes array
- Implemented normalizePrefix() helper
- Added getRegisteredRoutes() for testing
- All 81 tests passing (68 previous + 13 new)

### Refactor Phase ✅
- Verified code quality
- No new TypeScript errors

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/route-mounting.test.tsx`
**Purpose**: Test suite for route mounting and internal storage
**Tests**: 13 tests across 6 describe blocks

**Test Coverage**:
1. **Route storage - No prefix** (2 tests)
   - Simple routes without prefix
   - Route paths stored correctly

2. **Route storage - With prefix** (4 tests)
   - Routes with prefix
   - Prefix normalization (trailing slash removal)
   - Empty string as root
   - `/` as root

3. **Multiple registrations** (2 tests)
   - Multiple route groups
   - Registration order maintained

4. **Nested route registration** (2 tests)
   - Nested routes stored correctly
   - Nested routes flattened for access

5. **Prefix + nested** (1 test)
   - Combined prefix and nested structure

6. **Edge cases** (2 tests)
   - Empty route map
   - Duplicate path registration

---

### 2. Files Modified

#### `packages/rsc-router/src/create-router.ts`

**New Interface**:
```typescript
export interface RegisteredRoute {
  routes: ResolvedRouteMap<any>;
  prefix?: string;
  middleware: Middleware[];
}
```

**New Property**:
```typescript
private registeredRoutes: RegisteredRoute[] = [];
```

**Updated route() Method**:
```typescript
route(prefixOrRoutes, routeMap?) {
  let prefix, routes;

  if (typeof prefixOrRoutes === 'string') {
    prefix = this.normalizePrefix(prefixOrRoutes);
    routes = routeMap!;
  } else {
    routes = prefixOrRoutes;
  }

  // Store route registration
  this.registeredRoutes.push({
    routes,
    prefix,
    middleware: [],  // Empty for now, filled in Phase 3.3
  });

  return new RouteBuilder(this, routes, prefix);
}
```

**New Helper Method**:
```typescript
private normalizePrefix(prefix: string): string | undefined {
  if (!prefix || prefix === '/') {
    return undefined;  // Root mount
  }

  // Remove trailing slash
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}
```

**New Public Method (for testing)**:
```typescript
getRegisteredRoutes(): RegisteredRoute[] {
  return [...this.registeredRoutes];
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
✓ src/__tests__/sanity.test.ts (3 tests) 1ms
✓ src/__tests__/route-symbols.test.tsx (15 tests) 4ms
✓ src/__tests__/route-definition.test.ts (18 tests) 4ms
✓ src/__tests__/route-nested.test.ts (14 tests) 4ms
✓ src/__tests__/route-mounting.test.tsx (13 tests) 4ms
✓ src/__tests__/create-router.test.tsx (18 tests) 4ms

Test Files  6 passed (6)
Tests  81 passed (81)
Duration  719ms
```

**Status**: ✅ 100% passing (81/81 tests)

### Type Safety
```bash
pnpm type-check
```

**New code**: ✅ No new TypeScript errors
**Expected warnings**: RouteBuilder unused parameters (for Phases 3.3, 3.4)

### Linting
```bash
pnpm lint
```

**New code**: ✅ No lint errors or warnings

---

## API Specification

### Route Storage Structure

```typescript
interface RegisteredRoute {
  routes: ResolvedRouteMap<any>;  // The route map
  prefix?: string;                 // Optional path prefix
  middleware: Middleware[];        // Route-specific middleware (Phase 3.3)
}
```

### Prefix Normalization Rules

| Input | Normalized | Reason |
|-------|------------|--------|
| `'/blog'` | `'/blog'` | Standard prefix |
| `'/blog/'` | `'/blog'` | Remove trailing slash |
| `''` | `undefined` | Empty = root mount |
| `'/'` | `undefined` | Slash = root mount |
| `'/api/v1'` | `'/api/v1'` | Multi-segment prefix |
| `'/api/v1/'` | `'/api/v1'` | Trailing slash removed |

### Internal Storage

```typescript
const router = createRSCRouter();

router.route('/blog', blogRoutes);
router.route('/admin', adminRoutes);
router.route(mainRoutes);  // No prefix

// Internal state:
router.getRegisteredRoutes() === [
  { routes: blogRoutes, prefix: '/blog', middleware: [] },
  { routes: adminRoutes, prefix: '/admin', middleware: [] },
  { routes: mainRoutes, prefix: undefined, middleware: [] }
]
```

---

## Design Decisions

### 1. Immediate Storage
Routes are stored immediately when `.route()` is called:

**Rationale**:
- Simple implementation
- Allows introspection before `.map()` call
- Supports use cases where `.map()` might be optional
- Middleware will be added later (Phase 3.3)

### 2. Prefix Normalization
Automatically normalize prefixes:

```typescript
router.route('/blog/', routes)  // Stored as '/blog'
router.route('/', routes)       // Stored as undefined
```

**Rationale**:
- Consistent internal representation
- Easier path matching
- Prevents `/blog//index` double-slash issues
- Root mount clearly identified

### 3. Separate middleware Array
Each registration has its own middleware array:

```typescript
{
  routes,
  prefix,
  middleware: []  // Isolated per registration
}
```

**Rationale**:
- Middleware scoped to route group
- No interference between registrations
- Clear separation of concerns
- Will be populated in Phase 3.3

### 4. Registration Order Preserved
Array-based storage maintains order:

**Rationale**:
- Linear matching requires order
- First registered route matched first (Hono-style)
- Predictable behavior
- Easy debugging

---

## Implementation Highlights

### normalizePrefix() Logic
```typescript
private normalizePrefix(prefix: string): string | undefined {
  if (!prefix || prefix === '/') {
    return undefined;  // Root mount
  }

  // Remove trailing slash
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}
```

**Cases Handled**:
- Empty string → `undefined`
- `/` → `undefined`
- `/blog/` → `/blog`
- `/api/v1/` → `/api/v1`

### Route Storage
```typescript
this.registeredRoutes.push({
  routes,
  prefix,
  middleware: [],
});
```

**Simple and Effective**:
- Array-based for linear matching
- Complete route metadata
- Ready for Phase 3.3 (middleware) and 3.4 (handlers)

---

## Examples from Tests

### Example 1: No Prefix
```typescript
const router = createRSCRouter();
const routes = route({ home: '/', about: '/about' });

router.route(routes);

router.getRegisteredRoutes();
// [{ routes, prefix: undefined, middleware: [] }]
```

### Example 2: With Prefix
```typescript
const router = createRSCRouter();
const routes = route({ index: '/', post: '/:slug' });

router.route('/blog', routes);

router.getRegisteredRoutes();
// [{ routes, prefix: '/blog', middleware: [] }]
```

### Example 3: Prefix Normalization
```typescript
router.route('/blog/', routes);   // Trailing slash
router.getRegisteredRoutes()[0].prefix;  // '/blog' (normalized)

router.route('/', routes);        // Root
router.getRegisteredRoutes()[0].prefix;  // undefined

router.route('', routes);         // Empty
router.getRegisteredRoutes()[0].prefix;  // undefined
```

### Example 4: Multiple Registrations
```typescript
router.route(mainRoutes);
router.route('/blog', blogRoutes);
router.route('/admin', adminRoutes);

router.getRegisteredRoutes();
// [
//   { routes: mainRoutes, prefix: undefined, middleware: [] },
//   { routes: blogRoutes, prefix: '/blog', middleware: [] },
//   { routes: adminRoutes, prefix: '/admin', middleware: [] }
// ]
```

### Example 5: Nested Routes
```typescript
const routes = route({
  blog: {
    index: '/blog',
    post: '/blog/:slug'
  }
});

router.route(routes);

// Stored as-is (nested structure preserved)
router.getRegisteredRoutes()[0].routes === routes;  // true
router.getRegisteredRoutes()[0].routes.getAllPaths();
// ['/blog', '/blog/:slug']
```

---

## Path Composition Strategy

Paths are **NOT** composed at registration time:

```typescript
router.route('/blog', route({ index: '/', post: '/:slug' }));

// Stored as:
// { routes: { index: '/', post: '/:slug' }, prefix: '/blog' }
```

**Composition happens at match time**:
- Registration: Store paths as-is
- Matching: Combine prefix + path (Phase 4.1+)
- Example: `/blog` + `/:slug` → `/blog/:slug`

**Rationale**:
- Lazy composition (performance)
- Original paths preserved
- Debugging easier (see original definitions)
- Supports dynamic prefix changes (if needed)

---

## Known Limitations (Phase 3.2)

1. **No conflict detection**: Duplicate paths accepted (handled at match time)
2. **No validation**: Invalid prefixes/paths accepted (validated at match time)
3. **No handler storage**: Handlers added in Phase 3.4 (via `.map()`)

These are intentional - keeps Phase 3.2 focused on storage only.

---

## Success Criteria

- [x] RegisteredRoute interface defined
- [x] registeredRoutes storage implemented
- [x] Prefix normalization working
- [x] getRegisteredRoutes() for testing
- [x] Routes stored immediately on .route() call
- [x] Multiple registrations supported
- [x] Registration order preserved
- [x] Nested routes stored correctly
- [x] 13 comprehensive tests
- [x] All 81 tests passing (100%)
- [x] No new TypeScript errors
- [x] No lint issues
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── create-router.ts                     # Updated: route storage
├── route-definition.ts                  # Existing
├── __tests__/
│   ├── route-mounting.test.tsx          # NEW: 13 tests
│   ├── create-router.test.tsx           # Existing: 18 tests
│   ├── route-symbols.test.tsx           # Existing: 15 tests
│   ├── route-nested.test.ts             # Existing: 14 tests
│   ├── route-definition.test.ts         # Existing: 18 tests
│   ├── sanity.test.ts                   # Existing: 3 tests
│   └── setup.ts                         # Existing
└── index.ts                             # Existing
```

---

## Next Steps

**Phase 3.3**: Implement RouteBuilder.use() method
- Store route-specific middleware
- Connect to RegisteredRoute.middleware array
- Enable scoped middleware chains

**Phase 3.4**: Implement RouteBuilder.map() method
- Map handlers to routes
- Type-safe handler validation
- Complete route registration

---

## Notes

- Route storage is simple and efficient
- Prefix normalization prevents common errors
- Ready for middleware implementation (Phase 3.3)
- Ready for handler mapping (Phase 3.4)
- All quality checks passing
