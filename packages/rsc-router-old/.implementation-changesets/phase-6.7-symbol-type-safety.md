# Phase 6.7: Symbol Type Safety (Enhancement)

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~15 minutes

---

## Objective

Add complete type safety for symbol values, ensuring TypeScript validates:
- Symbol value types (layout, parallel, loading, error, revalidate)
- Parallel route names (must start with @)
- Per-route object structure
- All symbol combinations

---

## Changes Made

### Symbol Value Types Added

```typescript
// Layout: single, array, or per-route
export type LayoutValue<T> =
  | RouteHandler
  | RouteHandler[]
  | { [K in keyof T]?: RouteHandler | RouteHandler[] };

// Parallel routes: global or per-route, @ prefix enforced!
export type ParallelValue<T> =
  | Record<`@${string}`, RouteHandler>
  | { [K in keyof T]?: Record<`@${string}`, RouteHandler> };

// Loading: component or per-route
export type LoadingValue<T> =
  | RouteHandler
  | { [K in keyof T]?: RouteHandler };

// Error: component or per-route
export type ErrorValue<T> =
  | RouteHandler
  | { [K in keyof T]?: RouteHandler };

// Revalidate: function or per-route with layout option
export type RevalidateValue<T> =
  | ((ctx: any) => boolean)
  | ({ [K in keyof T]?: (ctx: any) => boolean } & {
      [layoutSymbol]?: (ctx: any) => boolean;
    });
```

### Updated HandlersForRouteMap

```typescript
export type HandlersForRouteMap<T> = {
  [K in keyof T]?: /* route handlers */;
} & {
  // Type-safe symbols with specific value types
  [layoutSymbol]?: LayoutValue<T>;
  [parallelSymbol]?: ParallelValue<T>;
  [loadingSymbol]?: LoadingValue<T>;
  [errorSymbol]?: ErrorValue<T>;
  [revalidateSymbol]?: RevalidateValue<T>;
};
```

---

## Type Safety Benefits

### 1. Parallel Routes: @ Prefix Enforced

```typescript
map(routes, {
  [route.parallel]: {
    '@sidebar': Sidebar,     // ✅ Valid
    '@modal': Modal,         // ✅ Valid
    'sidebar': Sidebar       // ❌ TypeScript error
  }
});
```

**Template literal type** `` Record<`@${string}`, Handler> `` enforces the prefix!

### 2. Layout Arrays Type-Safe

```typescript
map(routes, {
  [route.layout]: [L1, L2, L3],  // ✅ Valid
  [route.layout]: 'string',       // ❌ TypeScript error
  [route.layout]: 123,            // ❌ TypeScript error
});
```

### 3. Per-Route Validation

```typescript
const routes = route({ home: '/', about: '/about' });

map(routes, {
  [route.layout]: {
    home: HomeLayout,       // ✅ Valid
    about: AboutLayout,     // ✅ Valid
    contact: ContactLayout  // ❌ TypeScript error ('contact' not in routes)
  }
});
```

### 4. Revalidate Function Type

```typescript
map(routes, {
  [route.revalidate]: (ctx) => true,  // ✅ Valid: must return boolean
  [route.revalidate]: (ctx) => 'yes', // ❌ TypeScript error: must be boolean
});
```

### 5. Per-Route Revalidate

```typescript
map(routes, {
  [route.revalidate]: {
    [route.layout]: (ctx) => true,   // ✅ Special: layout revalidation
    home: (ctx) => false,             // ✅ Route revalidation
    about: (ctx) => true              // ✅ Route revalidation
  }
});
```

---

## Test Results

All 239 tests passing ✅

---

## Success Criteria

- [x] LayoutValue type with all variants
- [x] ParallelValue type with @ prefix enforcement
- [x] LoadingValue type (component or per-route)
- [x] ErrorValue type (component or per-route)
- [x] RevalidateValue type (function or per-route)
- [x] HandlersForRouteMap uses typed symbol values
- [x] Template literal types for @ prefix
- [x] All tests passing
- [x] No new TypeScript errors
- [x] Full symbol type safety achieved

---

## Symbol Type Safety Summary

**BEFORE** (Phase 6.4):
```typescript
[K: symbol]: any;  // Any symbol, any value
```

**AFTER** (Phase 6.7):
```typescript
[layoutSymbol]?: LayoutValue<T>;
[parallelSymbol]?: ParallelValue<T>;
[loadingSymbol]?: LoadingValue<T>;
[errorSymbol]?: ErrorValue<T>;
[revalidateSymbol]?: RevalidateValue<T>;
```

**Result**: TypeScript now knows:
- Which symbols are valid
- What value type each symbol expects
- Autocomplete for all symbols
- Errors for wrong value types

---

**SYMBOL TYPE SAFETY: COMPLETE! ✅**
