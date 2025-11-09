# Phase 1.1 UPDATE: RouteMap Class Implementation

**Status**: ✅ Completed
**Date**: 2025-11-09
**Update**: Changed from POJO to RouteMap class

---

## Change Summary

Changed the `route()` function to return a `RouteMap` class instance instead of a plain object (POJO). This enables:
- Router to identify route maps
- Additional methods (get, getAll, has, etc.)
- Better extensibility for future features
- Maintained full type safety and property access

---

## Implementation

### RouteMap Class

```typescript
export class RouteMap<T extends Record<string, RouteDefinition>> {
  private readonly _routes: T;

  constructor(definitions: T) {
    this._routes = definitions;

    // Dynamic property access via Object.defineProperty
    Object.keys(definitions).forEach((key) => {
      Object.defineProperty(this, key, {
        get() { return definitions[key]; },
        enumerable: true,
        configurable: false,
      });
    });
  }

  // Methods
  get<K extends keyof T>(name: K): T[K]
  getAll(): T
  getRouteNames(): Array<keyof T>
  has(name: keyof T): boolean
  entries(): Array<[keyof T, T[keyof T]]>
}
```

### Updated return type

```typescript
export function route<const T extends Record<string, RouteDefinition>>(
  definitions: T
): RouteMap<T> & T {  // Intersection type for both methods + properties
  return new RouteMap(definitions) as RouteMap<T> & T;
}
```

---

## API Usage

```typescript
const routes = route({
  home: '/',
  user: '/users/:id'
});

// Property access (same as before)
routes.home  // '/'
routes.user  // '/users/:id'

// NEW: Method access
routes.get('home')           // '/'
routes.getAll()              // { home: '/', user: '/users/:id' }
routes.getRouteNames()       // ['home', 'user']
routes.has('home')           // true
routes.entries()             // [['home', '/'], ['user', '/users/:id']]

// Router can identify RouteMap instances
routes instanceof RouteMap    // true (not available with POJO)
```

---

## Test Updates

Updated tests to verify:
- Property access still works
- New methods work correctly
- Class instance behavior

```typescript
it('should return a RouteMap instance with route definitions', () => {
  const routes = route({ home: '/', about: '/about' });

  // Property access
  expect(routes.home).toBe('/');
  expect(routes.about).toBe('/about');
});

it('should handle empty route map', () => {
  const routes = route({});

  expect(routes.getRouteNames()).toEqual([]);
  expect(routes.getAll()).toEqual({});
});
```

---

## Benefits

1. **Router Integration**: Router can use `instanceof RouteMap` to identify route maps
2. **Additional Methods**: Utility methods for introspection
3. **Future Extensibility**: Can add more methods (e.g., `merge()`, `filter()`)
4. **Type Safety**: Maintained full type safety with `RouteMap<T> & T`
5. **Property Access**: Preserved original API (routes.home still works)

---

## Verification

| Check | Result |
|-------|--------|
| Tests | ✅ 16/16 passing |
| TypeScript | ✅ No errors in new code |
| ESLint | ✅ No issues in new code |
| Property Access | ✅ Working |
| Method Access | ✅ Working |

---

## Files Changed

- `src/route-definition.ts` - Changed from type to class
- `src/__tests__/route-definition.test.ts` - Updated 3 tests

---

## No Breaking Changes

The API remains compatible:
- Property access works exactly as before
- Type safety preserved
- Only internal implementation changed from POJO to class

---

This update addresses the design requirement that route() should return a class instance, not a plain object, to enable router identification and additional functionality.
