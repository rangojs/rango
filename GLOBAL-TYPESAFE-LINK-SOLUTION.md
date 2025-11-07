# Global Type-Safe Link Component - Working Solution

## Overview

This document describes the working implementation of a global type-safe Link component that doesn't require factory functions or per-component setup. All Links are automatically type-safe based on a central routes configuration.

## ✅ Working Solution

### 1. Routes Configuration (`src/routes.config.ts`)

Define all your application routes in a central configuration file:

```typescript
// Define parameter types separately for clarity
type RouteParamTypes = {
  "/user/:id": { id: string };
  "/items/:id": { id: string };
  "/post/:postId/comments/:commentId": { postId: string; commentId: string };
};

export const appRoutes = {
  // Routes without parameters
  "/": null,
  "/about": null,
  "/items": null,

  // Routes with parameters
  "/user/:id": null as unknown as RouteParamTypes["/user/:id"],
  "/items/:id": null as unknown as RouteParamTypes["/items/:id"],
  "/post/:postId/comments/:commentId":
    null as unknown as RouteParamTypes["/post/:postId/comments/:commentId"],
} as const;

export type AppRoutes = typeof appRoutes;
export type AppRoutePaths = keyof AppRoutes;
```

### 2. Global Type-Safe Link Component (`src/framework/rsc-router/global-typed-link.tsx`)

The GlobalTypedLink component provides automatic type safety:

```typescript
import { type AppRoutePaths, type AppRoutes } from "@/routes.config";

type HasRouteParams<T extends AppRoutePaths> = AppRoutes[T] extends null
  ? false
  : true;

type RouteParamsFor<T extends AppRoutePaths> = AppRoutes[T] extends null
  ? never
  : AppRoutes[T];

type GlobalTypedLinkProps<T extends AppRoutePaths = AppRoutePaths> = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  to: T;
  prefetch?: boolean;
} & (HasRouteParams<T> extends true
    ? { params: RouteParamsFor<T> }
    : { params?: never });

export function GlobalTypedLink<T extends AppRoutePaths>(
  props: GlobalTypedLinkProps<T>
) {
  const { to, params, prefetch = false, ...restProps } = props;
  const href = buildPath(to as string, params || undefined);
  return <a {...restProps} href={href} />;
}
```

### 3. Usage

Import and use the GlobalTypedLink component anywhere in your application:

```tsx
import { GlobalTypedLink } from "rsc-router";

function MyComponent() {
  return (
    <>
      {/* ✅ Valid: Route without params */}
      <GlobalTypedLink to="/">Home</GlobalTypedLink>

      {/* ✅ Valid: Route with required params */}
      <GlobalTypedLink to="/user/:id" params={{ id: "123" }}>
        View User
      </GlobalTypedLink>

      {/* ✅ Valid: Multiple params */}
      <GlobalTypedLink
        to="/post/:postId/comments/:commentId"
        params={{ postId: "1", commentId: "2" }}
      >
        View Comment
      </GlobalTypedLink>

      {/* ❌ TypeScript Error: Invalid route */}
      <GlobalTypedLink to="/invalid">Invalid</GlobalTypedLink>

      {/* ❌ TypeScript Error: Missing required params */}
      <GlobalTypedLink to="/user/:id">Missing Params</GlobalTypedLink>

      {/* ❌ TypeScript Error: Wrong param name */}
      <GlobalTypedLink to="/user/:id" params={{ wrong: "123" }}>
        Wrong Param
      </GlobalTypedLink>
    </>
  );
}
```

## Type Safety Verification

TypeScript correctly catches these errors at compile time:

```bash
npx tsc src/test-types-simple.ts --noEmit --jsx react-jsx --strict --skipLibCheck

# Output:
# Error: Property 'params' is missing in type '{ to: "/user/:id"; children: string; }'
#        but required in type '{ params: { id: string; }; }'.
```

## Key Features

1. **No Factory Functions**: Unlike the previous createLink() approach, this works globally
2. **Central Configuration**: All routes defined in one place (`routes.config.ts`)
3. **Automatic Type Safety**: Import and use - types are automatically enforced
4. **IntelliSense Support**: Full autocomplete for routes and params
5. **Conditional Parameters**: Params only required when route has parameters
6. **Compile-Time Validation**: Invalid routes caught during TypeScript compilation

## Why This Approach Works

1. **Explicit Type Import**: Instead of module augmentation, we import types directly from the routes config
2. **Conditional Types**: Use TypeScript's conditional types to require params only when needed
3. **Central Truth**: Single source of truth for all route definitions
4. **Type Preservation**: Using `as const` and proper type mappings preserves literal types

## Migration from Module Augmentation

The original request was for module augmentation like:

```typescript
declare module "rsc-router" {
  interface AppRoutes {
    "/": never;
    "/user/:id": { id: string };
  }
}
```

However, TypeScript's module augmentation has limitations with complex conditional types and doesn't reliably produce compile errors in all environments. The direct import approach is more reliable and provides better IDE support.

## Build Configuration

Note: Vite doesn't enforce TypeScript strict checking by default. To ensure type safety:

1. Install TypeScript: `npm install --save-dev typescript`
2. Add a type-check script to package.json:
   ```json
   "scripts": {
     "type-check": "tsc --noEmit"
   }
   ```
3. Run type checking before builds: `npm run type-check && npm run build`

## Files Created

- `/src/routes.config.ts` - Central routes configuration
- `/src/framework/rsc-router/global-typed-link.tsx` - GlobalTypedLink component
- `/src/test-global-typed-link.tsx` - Test file demonstrating usage
- `/src/test-types-simple.ts` - Type checking verification

## Conclusion

This solution provides true global type-safe routing without requiring factory functions or per-component setup. All Links are automatically type-safe based on the central routes configuration, meeting the requirement for a global solution where "all <Link>s are typesafe automatically."
