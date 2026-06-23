---
name: composability
description: Reusable composition patterns with globally importable route helpers in @rangojs/router
argument-hint: "pattern-name"
---

# Composability

Route helpers can be imported directly from `@rangojs/router` and used to build reusable composition factories. This enables sharing common route configurations across multiple routes and modules.

## Globally Importable Helpers

These helpers can be imported and called outside the `urls()` callback parameter:

```typescript
import {
  layout,
  cache,
  middleware,
  revalidate,
  loader,
  loading,
  parallel,
  intercept,
  errorBoundary,
  notFoundBoundary,
} from "@rangojs/router";
```

They work because they use AsyncLocalStorage internally and resolve context at call time, not import time.

## Why path() and include() Are Not Global

`path()` and `include()` remain exclusive to the `urls()` callback:

```typescript
urls(({ path, include }) => [
  path("/blog", BlogPage, { name: "blog" }),
  include("/shop", shopPatterns, { name: "shop" }),
]);
```

They define the route structure -- the URL patterns and how modules compose. Keeping them in the `urls()` callback makes the route tree readable at a glance. When scanning a URL file, `path()` and `include()` calls show what renders where. Moving them into factories would hide the routing structure and make it harder to understand which URLs exist and how they nest.

The globally importable helpers (`cache`, `middleware`, `loading`, etc.) are configuration -- they modify behavior of routes but don't define routes themselves. Extracting them into factories doesn't obscure the route structure.

## Composition Factories

Define reusable factories that return arrays of use items:

```typescript
import { cache, revalidate, loading, errorBoundary, middleware } from "@rangojs/router";

// Shared caching configuration
const withCaching = () => [
  cache({ ttl: 600_000 }),
  // Defer on navigation (|| undefined) so each route keeps its own param/search
  // revalidation default; only force a re-run when an action ran.
  revalidate(({ actionId }) => (actionId ? true : undefined)),
];

// Shared loading and error handling
const withLoadingAndError = (skeleton: ReactNode) => [
  loading(skeleton),
  errorBoundary(() => <div>Something went wrong</div>),
];

// Shared auth middleware
const withAuth = () => [
  middleware(authMiddleware),
  middleware(loggingMiddleware),
];
```

> **Factories compose logic, not just values.** A `revalidate()` predicate in a
> shared factory applies its logic to _every_ route that composes it, so a
> footgun here is amplified across the app. Two rules:
>
> 1. Use `|| undefined` (defer), not `?? false` (hard short-circuit), in shared
>    predicates — a hard `false` ends the chain and overrides each consuming
>    route's own default, and a downstream revalidator never runs. See `/loader`
>    → "`|| undefined` (defer) vs `?? false` (hard)".
> 2. Match actions with `ctx.isAction(Action)`, not an inline
>    `actionId.includes("…")` buried in a factory: it resolves the action from an
>    imported reference, so a rename is a compile error in one place instead of
>    silent drift across every consumer.
>
> Remember the axis: a factory's `revalidate()` controls client-update
> selection, while its `cache()` controls stored-value freshness. They are
> independent even when bundled in the same factory (`/cache-guide` → "Two axes").

> **Keep factories small and intention-named.** The anti-pattern that kills
> readability is over-bundling — a `withDefaults()` that secretly adds five
> things — and factory-of-factories nesting (leaning on `.flat(3)`). Surprising
> config stays inline; extract only the boring, repeated parts; compose by
> _naming concerns_ (`withAuth()`, `withCaching()`), not by hiding them.

## Using Factories in Routes

Place factory calls inside `path()` or `layout()` use callbacks. The returned arrays are flattened automatically (up to 3 levels):

```typescript
import { urls } from "@rangojs/router";
import { withCaching, withLoadingAndError, withAuth } from "./route-config";

export const urlpatterns = urls(({ path, layout }) => [
  layout(<AppLayout />, () => [
    withAuth(),

    path("/blog", BlogIndex, { name: "blog" }, () => [
      withCaching(),
      withLoadingAndError(<BlogSkeleton />),
    ]),

    path("/shop", ShopIndex, { name: "shop" }, () => [
      withCaching(),
      withLoadingAndError(<ShopSkeleton />),
    ]),
  ]),
]);
```

## Sharing Across Modules

Factories can be defined in shared modules and reused across separate `urls()` definitions:

```typescript
// src/route-config.ts
import { cache, revalidate, middleware } from "@rangojs/router";
import { authMiddleware } from "./middleware/auth";

export const withPublicDefaults = () => [
  cache({ ttl: 300 }),
  revalidate(({ actionId }) => (actionId ? true : undefined)),
];

export const withProtectedDefaults = () => [
  middleware(authMiddleware),
  cache({ ttl: 60 }),
];
```

```typescript
// src/urls/blog.ts
import { urls } from "@rangojs/router";
import { withPublicDefaults } from "../route-config";

export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }, () => [withPublicDefaults()]),
]);
```

```typescript
// src/urls/admin.ts
import { urls } from "@rangojs/router";
import { withProtectedDefaults } from "../route-config";

export const adminPatterns = urls(({ path }) => [
  path("/", AdminDashboard, { name: "index" }, () => [withProtectedDefaults()]),
]);
```

## Composition Types

For typed factories, import the composition types:

```typescript
import type { RouteUseItem, LayoutUseItem, UseItems } from "@rangojs/router";

// Factory for path() use callbacks
const withCaching = (): RouteUseItem[] => [
  cache({ ttl: 600_000 }),
];

// Factory for layout() use callbacks
const withAuth = (): LayoutUseItem[] => [
  middleware(authMiddleware),
];

// Factory that nests other factories (use UseItems for nested arrays)
const withEverything = (): UseItems<RouteUseItem> => [
  withCaching(),
  loading(<Skeleton />),
];
```

- `RouteUseItem[]` -- flat array for `path()` use callbacks
- `LayoutUseItem[]` -- flat array for `layout()` use callbacks
- `UseItems<T>` -- allows nested arrays from composing factories together

## Rules

- Helpers execute lazily -- factory functions are defined anywhere, but only called inside a `urls()` context (within `path()` or `layout()` use callbacks)
- Calling helpers outside a `urls()` context throws an error
- Nested arrays from factories are flattened automatically via `.flat(3)`
- `path()` and `include()` cannot be used in factories -- they define route structure and must remain visible in the `urls()` callback
