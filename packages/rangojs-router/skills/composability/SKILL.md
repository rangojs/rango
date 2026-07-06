---
name: composability
description: Reusable composition patterns with globally importable route helpers in @rangojs/router. Use when sharing loaders, middleware, or handler logic across multiple route files, or avoiding copy-pasting the same route setup everywhere.
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

## Code-splitting a route group with async include()

`include()` takes a route module two ways. Eager — the module is already in the
graph:

```typescript
import { shopPatterns } from "./shop-patterns";

urls(({ include }) => [include("/shop", shopPatterns, { name: "shop" })]);
```

Async — the module is code-split behind a `() => import()` thunk. It becomes its
own chunk that is NOT evaluated at startup; the router imports it on the first
request that reaches the prefix, then caches it:

```typescript
urls(({ include }) => [
  include("/shop", () => import("./shop-patterns"), { name: "shop" }),
]);
```

The split module exposes its `urls()` value as the default export (convention):

```typescript
// src/shop-patterns.ts
import { urls } from "@rangojs/router";

export const shopPatterns = urls(({ path, include }) => [
  path("/", ShopHome, { name: "home" }),
  include("/product", productPatterns, { name: "product" }), // nesting is fine
]);

export default shopPatterns; // async include() resolves this
```

**Prefer the async form** for any route group that is a natural,
independently-loadable unit (a localized section, an admin area, an API surface
with heavy handlers) — it trims the eagerly-parsed entry bundle and keeps that
subgraph off the cold-start path. The **eager form is still fully valid** (not
deprecated): keep it for small groups, or ones that share most of their module
graph with the entry (the bundler keeps shared modules common regardless, so
splitting a thin group buys little). Both match identically at runtime — only the
module's runtime evaluation timing differs.

What you do NOT lose by splitting: build-time discovery `await`s the provider, so
`href()`, `reverse()`, generated route types, and prerender still see every route
in the group — including nested `include()`s inside the split module. Only the
module's runtime evaluation defers. `rango generate` resolves the `() => import()`
the same way, so a code-split group is still fully typed.

### Sizing async include groups (measured)

The first request into an async group pays that group's chunk import; every
request after that is flat. Measured on a deployed Cloudflare worker with
26k routes (2026-07, warm RTT floor ~23 ms):

| Group size                 | First-hit latency                    |
| -------------------------- | ------------------------------------ |
| ~240 routes                | ~75 ms (≈ RTT + eval)                |
| ~5,000 routes              | ~137 ms                              |
| ~9,000 routes              | ~188 ms                              |
| 3-level nested async chain | ~464 ms (levels import sequentially) |

Three rules fall out of those numbers:

1. **Prefer more, smaller groups over few giant ones.** First-hit cost scales
   with routes-per-chunk; fifty 250-route groups each cost a fraction of one
   9k-route group, and only the group actually visited pays anything.
2. **Keep async-include chains shallow on latency-sensitive paths.** Each
   nested `() => import()` level awaits in sequence, so depth multiplies the
   first hit. Nesting eager includes inside one async module costs one chunk;
   nesting async inside async costs one chunk per level.
3. **Give sibling groups distinct static prefixes.** Siblings that share a
   static prefix (`include("/x/:a", …)` next to `include("/x/:b", …)`) all
   import on the first hit to that prefix — the router cannot tell which one
   matches before loading them.

Warm-path matching is O(path segments) via the precomputed trie regardless of
group layout — this sizing only shapes cold/first-hit behavior. For
latency-critical prefixes, a post-deploy warmup ping (one request per prefix)
erases first-hit cost for the isolate entirely.

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
