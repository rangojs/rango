# Router API Ideas

## Multiple Route Files with Route-Level Metadata

### Basic Route Definition

```typescript
import { createRouter, route, middleware, layout } from "rsc-router";
// middleware, layout are special symbols used to define route-level metadata

// `route()` creates a "route map" that organizes routes by name. The keys
// of the map may be any name, and may be nested to group related routes.
let routesMain = route({
  home: "/",
  about: "/about",
});

let routesBlog = route({
  index: "/",
  show: "/:slug",
});

let routes = route(routesMain, {
  blog: routesBlog,
});

type Routes = typeof routes;
// {
//   home: Route<ALL, '/'>
//   about: Route<ALL, '/about'>
//   blog: {
//     index: Route<ALL, '/blog'>
//     show: Route<ALL, '/blog/:slug'>
//   },
// }

let router = createRouter(routes, {
  // Middleware may be used to run code before and/or after route handlers run.
  // In this case, the `logger()` middleware logs the request to the console.
  [route.middleware]: [logger()],
});

// Map the routes to "handlers" for each route. The structure of the route
// handlers object mirrors the structure of the route map, with full type safety.
router.map(routesBlog, () => import("route.blog.handlers"));
```

### Route Handlers File

```typescript
// route.blog.handlers.ts
map(routesBlog, {
  [route.middleware]: [auth(), blogTracker()],
  [route.layout]: () => import("blog/layout").then((m) => m.BlogLayout),

  index() {
    return new Response("Blog");
  },

  show(ctx) {
    return new Response(`Blog post: ${ctx.params.slug}`);
  },
});
```

---

## Single File with Route-Level Metadata

### Complete Route Configuration

```typescript
import { createRouter, route, middleware, layout } from "rsc-router";
// middleware, layout are special symbols used to define route-level metadata

// `route()` creates a "route map" that organizes routes by name. The keys
// of the map may be any name, and may be nested to group related routes.
let routes = route({
  home: "/",
  about: "/about",
  blog: {
    index: "/",
    show: "/:slug",
  },
});

type Routes = typeof routes;
// {
//   home: Route<ALL, '/'>
//   about: Route<ALL, '/about'>
//   blog: {
//     index: Route<ALL, '/blog'>
//     show: Route<ALL, '/blog/:slug'>
//   },
// }

let router = createRouter(routes, {
  // Middleware may be used to run code before and/or after route handlers run.
  // In this case, the `logger()` middleware logs the request to the console.
  [route.middleware]: [logger()],
});

// Map the routes to "handlers" for each route. The structure of the route
// handlers object mirrors the structure of the route map, with full type safety.
router.map(routesBlog, () => import("route.blog.handlers"));

map(routes, {
  [route.loading]: {
    show: () => import("blog/loading").then((m) => m.BlogLoading),
  },
  [route.middleware]: [auth(), blogTracker()],
  [route.layout]: () => import("blog/layout").then((m) => m.BlogLayout),
  [route.revalidate]: {
    [route.layout]: (ctx) => true,
    show: (ctx) => {
        // {
        //  currentPath,
        //  nextPath,
        //  currentRouteName,
        //  nextRouteName,
        //  params,
        //  actionData,
        //  request,
        //  actionParams,
        //  }
    return false;
  },
      // Revalidate the `show` route only when navigating to a different blog post
      return ctx.next.params.slug !== ctx.current.params.slug;
    },
  }

  index() {
    return new Response("Blog");
  },

  show(ctx) {
    return new Response(`Blog post: ${ctx.params.slug}`);
  },


  // ... other route handlers
});
```

---

## HTTP Method-Specific Routes

### Route Definition with Explicit Methods

```typescript
let routes = route({
  home: {
    method: "GET",
    pattern: "/",
  },
  contact: {
    index: {
      method: "GET",
      pattern: "/contact",
    },
    action: {
      method: "POST",
      pattern: "/contact",
    },
  },
});
```

---

## Key Features

### 1. **Type Safety**

- Full TypeScript support with inferred types
- Structure of route handlers mirrors route map structure
- Compile-time validation of route parameters

### 2. **Modular Organization**

- Routes can be split across multiple files
- Lazy loading support with dynamic imports
- Nested route structures for logical grouping

### 3. **Middleware & Layouts**

- Route-level middleware configuration
- Layout components with lazy loading
- Revalidation control at route level

### 4. **Flexible Route Definitions**

- Simple string patterns for basic routes
- Object notation for HTTP method-specific routes
- Nested structures for related routes

### 5. **Revalidation Control**

- Fine-grained revalidation strategies
- Access to navigation context (current/next paths, route names)
- Request and action data available in revalidation logic
