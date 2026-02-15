---
name: testing
description: Unit test route trees with buildRouteTree()
argument-hint:
---

# Route Tree Unit Testing

Unit test route definitions by inspecting the route tree, segment IDs, middleware, intercepts, loaders, and pattern matching without running a dev server.

## Setup

The `buildRouteTree` helper lives in `src/__tests__/helpers/route-tree.ts` (not shipped with npm). Import it in your test files:

```typescript
import { buildRouteTree } from "./helpers/route-tree.js";
```

## buildRouteTree(urlPatterns)

Takes a `urls()` result and returns a `RouteTree` with inspection methods:

```typescript
import { urls } from "@rangojs/router";
import { buildRouteTree } from "./helpers/route-tree.js";

const tree = buildRouteTree(
  urls(({ path, layout, middleware, loader, intercept, when }) => [
    layout(RootLayout, () => [
      middleware(authMiddleware),
      path("/", HomePage, { name: "home" }),
      path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
        loader(PostLoader),
      ]),
    ]),
  ])
);
```

## RouteTree API

### Route Patterns

```typescript
tree.routes()       // { home: "/", "blog.post": "/blog/:slug" }
tree.routeNames()   // ["home", "blog.post"]
```

### URL Matching

```typescript
const m = tree.match("/blog/hello");
m.routeKey  // "blog.post"
m.params    // { slug: "hello" }

tree.match("/nonexistent")  // null
```

### Segment IDs

```typescript
tree.segmentId("home")       // "M0L0L0R0"
tree.segmentIds()            // { home: "M0L0L0R0", "blog.post": "M0L0L0R1" }
tree.segmentPath("blog.post")
// [
//   { id: "M0L0",     type: "layout" },  // synthetic root
//   { id: "M0L0L0",   type: "layout" },  // RootLayout
//   { id: "M0L0L0R1", type: "route", pattern: "/blog/:slug" },
// ]
```

### Entry Access

```typescript
tree.entry("blog.post")                   // EntryData
tree.entry("blog.post")!.parent!.type     // "layout"
tree.entryByPattern("/blog/:slug")        // EntryData (lookup by URL pattern)
```

### Middleware

```typescript
tree.hasMiddleware("home")                // true (inherited from layout)
tree.middleware("home")                   // [authMiddleware] (direct only)
tree.middlewareChain("home")
// [{ segmentId: "M0L0L0", count: 1 }]   // all middleware root-to-route
```

### Loaders

```typescript
tree.hasLoaders("blog.post")  // true
tree.loaders("blog.post")     // [LoaderEntry { loader, revalidate, cache? }]
```

### Intercepts

```typescript
tree.intercepts("home")
// [{ slotName: "@modal", routeName: "card", hasWhen: true, whenCount: 1, hasLoader: false, hasMiddleware: false }]
tree.interceptEntries("home")  // raw InterceptEntry[]
```

### Parallel Slots

```typescript
tree.parallelSlots("home")       // EntryData[] of type="parallel"
tree.parallelSlotNames("home")   // ["@sidebar", "@main"]
```

### Boundaries

```typescript
tree.hasErrorBoundary("home")      // boolean
tree.hasNotFoundBoundary("home")   // boolean
```

### Cache & Loading

```typescript
tree.hasCache("home")     // boolean
tree.hasLoading("home")   // boolean
```

### Debug

```typescript
console.log(tree.debug());
// Route Tree:
//   home: / [M0L0L0R0] (M0L0 > M0L0L0 > M0L0L0R0) {mw:1}
//   blog.post: /blog/:slug [M0L0L0R1] (M0L0 > M0L0L0 > M0L0L0R1) {mw:1, ld:1}
```

## Segment ID Format

| Prefix | Meaning |
|--------|---------|
| `M0`   | Mount index (router instance) |
| `L`    | Layout |
| `R`    | Route |
| `P`    | Parallel slot |
| `D`    | Loader (data) |
| `C`    | Cache boundary |

Example: `M0L0L0R1` = mount 0, synthetic root layout, user layout, second route.

## Examples

### include() with prefix

```typescript
const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:slug", BlogPost, { name: "post" }),
]);

const tree = buildRouteTree(
  urls(({ path, include }) => [
    path("/", HomePage, { name: "home" }),
    include("/blog", blogPatterns, { name: "blog" }),
  ])
);

expect(tree.routes()).toEqual({
  home: "/",
  "blog.index": "/blog",
  "blog.post": "/blog/:slug",
});
```

### Middleware chain

```typescript
const authMw = async (ctx, next) => next();
const logMw = async (ctx, next) => next();

const tree = buildRouteTree(
  urls(({ path, layout, middleware }) => [
    layout(RootLayout, () => [
      middleware(logMw),
      layout(AuthLayout, () => [
        middleware(authMw),
        path("/dashboard", Dashboard, { name: "dashboard" }),
      ]),
    ]),
  ])
);

expect(tree.middlewareChain("dashboard")).toEqual([
  { segmentId: "M0L0L0", count: 1 },   // logMw on RootLayout
  { segmentId: "M0L0L0L0", count: 1 }, // authMw on AuthLayout
]);
```

### Intercepts with when()

```typescript
const tree = buildRouteTree(
  urls(({ path, layout, intercept, when }) => [
    layout(ShopLayout, () => [
      path("/products", ProductList, { name: "products" }),
      path("/products/:id", ProductDetail, { name: "product.detail" }),
      intercept("@modal", "product.detail", ProductModal, () => [
        when((ctx) => ctx.from.pathname.startsWith("/products")),
      ]),
    ]),
  ])
);

const intercepts = tree.intercepts("products");
// Note: intercepts are on the parent where intercept() is called
```

### Constrained parameters

```typescript
const tree = buildRouteTree(
  urls(({ path }) => [
    path("/:locale(en|fr)?/about", AboutPage, { name: "about" }),
  ])
);

expect(tree.match("/about")).not.toBeNull();
expect(tree.match("/fr/about")!.params).toEqual({ locale: "fr" });
expect(tree.match("/de/about")).toBeNull();
```
