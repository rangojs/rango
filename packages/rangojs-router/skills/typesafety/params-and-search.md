# Params and Search Types

## Typed Search Params

Add a `search` schema to `path()` options for type-safe query parameters:

```typescript
// Route definition with search schema
path("/search", SearchPage, {
  name: "search",
  search: { q: "string", page: "number?", sort: "string?" },
});
```

### Handler with typed search params

`Handler<"name">` automatically resolves route params and search params from the
global `GeneratedRouteMap` (the gen file). No explicit route map import needed:

```typescript
// pages/search.tsx
import type { Handler } from "@rangojs/router";

export const SearchPage: Handler<"search"> = (ctx) => {
  // ctx.search is typed: { q: string; page?: number; sort?: string }
  const { q, page, sort } = ctx.search;
  return <SearchResults q={q} page={page} sort={sort} />;
};
```

This avoids circular references because `Handler` defaults to `GeneratedRouteMap`
(from `router.named-routes.gen.ts`) instead of `RegisteredRoutes` (which depends on `router.tsx`).

You can also pass an explicit route map for per-module isolation (opt-in,
after running `npx rango generate`). With a local map, the route name is
**dot-prefixed** so params and search resolve from `routes`, not the global map:

```typescript
import type { Handler } from "@rangojs/router";
import type { routes } from "./urls.gen.js";

export const SearchPage: Handler<".search", routes> = (ctx) => { ... };
```

Note the difference: `Handler<"search">` (no dot) resolves against the global
`GeneratedRouteMap`; `Handler<".search", routes>` resolves against the local
`routes` map. Mixing them — `Handler<"search", routes>` — silently ignores
`routes` for param/search inference and only uses it for local `ctx.reverse(".x")`.

Supported types: `"string"`, `"number"`, `"boolean"`, with `?` suffix for optional.
Values are automatically coerced from query string (e.g., `"2"` becomes `2` for numbers).
Routes without a `search` schema keep the standard `URLSearchParams` behavior.

### RouteSearchParams and RouteParams utility types

Extract typed params by route name for use in component props, return types, or anywhere:

```typescript
import type { RouteSearchParams, RouteParams } from "@rangojs/router";

// RouteSearchParams<"name"> resolves the search schema to a typed object
type SP = RouteSearchParams<"search">;
// { q: string | undefined; page?: number; sort?: string }

// RouteParams<"name"> resolves URL params from the route pattern
type P = RouteParams<"blogPost">;
// { slug: string }

// Optional URL params (`:slug?`) resolve to `string | undefined`
// because absent segments are omitted from `ctx.params` at runtime.
type C = RouteParams<"checkout">;
// { step?: string }
// → ctx.params.step is `string | undefined`; use `?? "default"` to coalesce.

// Use in component props
interface SearchResultsProps {
  params: RouteSearchParams<"search">;
}
```

Both default to the global route map (`RegisteredRoutes` or `GeneratedRouteMap`).
Pass an explicit route map as the second type argument when needed:

```typescript
import type { routes } from "./urls.gen.js";

type SP = RouteSearchParams<"search", routes>;
type P = RouteParams<"blogPost", routes>;
```

### Generated route types

In the generated `router.named-routes.gen.ts`, routes with search schemas
use `{ path, search }` objects:

```typescript
// router.named-routes.gen.ts (auto-generated)
export const NamedRoutes = {
  "search.index": {
    path: "/search",
    search: { q: "string", page: "number?", sort: "string?" },
  },
  "home.index": "/", // No search schema -> plain string
} as const;
```

You never open a `.gen.ts` by hand. Treat the generated types as call-site
honesty checks, not modules to read:

- **Do not import `router.named-routes.gen.ts` directly**, and don't reach for
  `Rango.GeneratedRouteMap`. It is the whole-app manifest, auto-wired
  globally — `Handler<"name">` and `ctx.reverse("name")` already see it.
- **Per-module `*.gen.ts` imports are fine** — they are the opt-in local-route
  pattern for `useReverse(routes)` and explicit local handler typing
  (`Handler<".name", routes>`). See `/links`.

If a type error points at a generated map instead of your call site, that's a
smell — fix the call site (or regenerate), never edit the generated file.

## Loader Type Safety

Loaders have typed return values:

```typescript
// loaders/product.ts
export const ProductLoader = createLoader(async (ctx) => {
  return {
    id: ctx.params.slug,
    name: "Widget",
    price: 99,
  };
});

// In server component - type is inferred
import { useLoader } from "@rangojs/router/client";

async function ProductPage() {
  const product = await useLoader(ProductLoader);
  // product: { id: string; name: string; price: number }
  return <h1>{product.name}</h1>;
}

// In client component - same type
"use client";
import { useLoader } from "@rangojs/router/client";

function ProductPrice() {
  const { data } = useLoader(ProductLoader);
  // data: { id: string; name: string; price: number }
  const product = data;
  return <span>${product.price}</span>;
}
```
