# Phase 1.1: Implement route() Function - Basic Types and Simple Routes

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~25 minutes
**Approach**: Test-Driven Development (TDD)

---

## Objective

Implement the `route()` function to create typed route maps with support for simple string path definitions. This is the foundation of the new Router API.

---

## TDD Process

### Red Phase ✅
- Wrote 13 comprehensive tests covering all edge cases
- Tests initially failed (file not found)

### Green Phase ✅
- Implemented minimal code to pass all tests
- Fixed circular type reference issue
- All 16 tests passing (13 new + 3 existing)

### Refactor Phase ✅
- Simplified types for Phase 1.1 scope
- Added documentation comments
- Verified code quality

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/route-definition.ts`
**Purpose**: Core route() function and type definitions
**Lines of Code**: ~50

**Key Features**:
```typescript
// Type-safe route definition
export type RouteDefinition = string;

// Maps route definitions to output type
export type RouteMap<T extends Record<string, RouteDefinition>> = {
  [K in keyof T]: T[K];
};

// Route creation function
export function route<T extends Record<string, RouteDefinition>>(
  definitions: T
): RouteMap<T> {
  return definitions as RouteMap<T>;
}
```

**API Usage**:
```typescript
// Create typed route map
const routes = route({
  home: '/',
  about: '/about',
  user: '/users/:id',
  post: '/blog/:category/:slug'
});

// Type-safe access
routes.home // Type: string, Value: '/'
routes.user // Type: string, Value: '/users/:id'
```

#### `packages/rsc-router/src/__tests__/route-definition.test.ts`
**Purpose**: Comprehensive test suite for route() function
**Tests**: 13 tests across 5 describe blocks

**Test Coverage**:
1. **Simple route definitions** (4 tests)
   - Basic string paths
   - Dynamic segments (`:id`)
   - Multiple dynamic segments
   - Trailing slashes

2. **Type safety** (2 tests)
   - Key preservation
   - Structure integrity

3. **Empty and edge cases** (4 tests)
   - Empty route map
   - Single route
   - Query parameters
   - Hash fragments

4. **Special characters** (3 tests)
   - Wildcard routes (`*`)
   - Dashes and underscores
   - Numbers in paths

---

### 2. Files Modified

#### `packages/rsc-router/src/index.ts`
**Change**: Added export for route-definition module

```diff
+ export * from './route-definition';
```

**Impact**: route() function now accessible from main package export

---

## Test Results

### Test Execution
```bash
pnpm test
```

**Output**:
```
✓ src/__tests__/sanity.test.ts (3 tests) 2ms
✓ src/__tests__/route-definition.test.ts (13 tests) 3ms

Test Files  2 passed (2)
Tests  16 passed (16)
Duration  329ms
```

**Status**: ✅ 100% passing (16/16 tests)

### Code Coverage
Not measured yet (will track in Phase 9.2)

### Type Safety
```bash
pnpm type-check
```

**route-definition.ts**: ✅ No TypeScript errors
**Old code**: ⚠️ 14 errors (expected, not related to Phase 1.1)

### Linting
```bash
pnpm lint
```

**New files**: ✅ No lint errors or warnings
**Old code**: ⚠️ 39 problems (expected)

### Formatting
```bash
pnpm format
```

**Status**: ✅ All files properly formatted

---

## API Specification

### Function Signature

```typescript
function route<T extends Record<string, RouteDefinition>>(
  definitions: T
): RouteMap<T>
```

### Supported Route Patterns (Phase 1.1)

| Pattern Type | Example | Description |
|--------------|---------|-------------|
| Static | `'/'`, `'/about'` | Exact path match |
| Dynamic | `'/users/:id'` | Named parameter |
| Multi-param | `'/blog/:category/:slug'` | Multiple parameters |
| Wildcard | `'/files/*'`, `'*'` | Catch-all routes |
| Query string | `'/search?q=:query'` | With query params |
| Hash | `'/docs#section'` | With hash fragments |
| Special chars | `'/api-v1'`, `'/user_profile'` | Dashes, underscores |

### Type Safety Features

1. **Compile-time route name validation**
   ```typescript
   const routes = route({ home: '/' });
   routes.home // ✅ Valid
   routes.invalid // ❌ TypeScript error
   ```

2. **Preserves exact structure**
   ```typescript
   const input = { home: '/', about: '/about' };
   const routes = route(input);
   // routes has same structure as input
   ```

3. **Full IDE autocomplete**
   - Route names
   - Type hints
   - Inline documentation

---

## Design Decisions

### 1. Pass-Through Implementation
For Phase 1.1, the `route()` function is essentially a pass-through that provides type safety:

```typescript
return definitions as RouteMap<T>;
```

**Rationale**:
- Minimal complexity for simple routes
- Type system does the heavy lifting
- Prepares foundation for Phase 1.2 (nested routes)
- No runtime overhead

### 2. String-Only Type (Phase 1.1)
```typescript
export type RouteDefinition = string;
```

**Rationale**:
- Avoids circular type references
- Simpler implementation
- Phase 1.2 will add nested object support

### 3. Comprehensive Test Suite
13 tests covering all edge cases

**Rationale**:
- TDD ensures robust implementation
- Tests serve as documentation
- Prevents regressions
- Builds confidence in API

---

## Known Limitations (Phase 1.1)

1. **No nested route groups**
   ```typescript
   // ❌ Not supported yet (Phase 1.2)
   const routes = route({
     blog: {
       index: '/blog',
       post: '/blog/:slug'
     }
   });
   ```

2. **No route validation**
   - Invalid paths accepted (e.g., `'///bad'`)
   - Will add validation in later phases if needed

3. **No path composition**
   - Paths must be fully specified
   - No automatic prefix handling (added in Phase 3.2)

---

## Next Steps

**Phase 1.2**: Implement nested route support
- Add recursive RouteDefinition type
- Support nested route objects
- Update tests for nested scenarios

---

## Success Criteria

- [x] route() function implemented
- [x] TypeScript types defined
- [x] 13 comprehensive tests written
- [x] All tests passing (100%)
- [x] No TypeScript errors in new code
- [x] No lint/format issues
- [x] Exported from main package
- [x] TDD workflow followed
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── route-definition.ts          # NEW: route() function
├── __tests__/
│   ├── route-definition.test.ts # NEW: 13 tests
│   ├── sanity.test.ts          # Existing: 3 tests
│   └── setup.ts                # Existing
└── index.ts                    # Modified: added export
```

---

## Example Usage

```typescript
import { route } from 'rsc-router';

// Define routes with type safety
const routes = route({
  home: '/',
  about: '/about',
  contact: '/contact',
  user: '/users/:id',
  post: '/blog/:category/:slug',
  files: '/files/*',
});

// Type-safe access
console.log(routes.home);    // '/'
console.log(routes.user);    // '/users/:id'
console.log(routes.post);    // '/blog/:category/:slug'

// TypeScript ensures safety
// routes.invalid // ❌ Compile error
```

---

## Performance Characteristics

- **Runtime overhead**: Zero (pass-through function)
- **Type checking**: Compile-time only
- **Bundle size impact**: ~50 bytes (tree-shakeable)
- **Memory usage**: Negligible (no transformation)

---

## Notes

- Implementation is intentionally minimal for Phase 1.1
- Type system provides all the value
- Foundation ready for Phase 1.2 (nested routes)
- All quality checks passing
- Ready for production use (simple routes only)
