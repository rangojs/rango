# Router API Ideas

## Multiple Route Files with Route-Level Metadata

### Basic Route Definition

```typescript
import { createRSCRouter, route,  layout } from "rsc-router";
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






let app = createRSCRouter({
  //other configs TBD
});

// Map the routes to "handlers" for each route. The structure of the route
// handlers object mirrors the structure of the route map, with full type safety.
app.route(routesBlog)
  .use(async (...)=>{ // any middleware here})
  // lazy middleware import
  .use(() => import("route.blog.middleware"))
  .map(() => import("route.blog.handlers"))
app.route(routesMain)
  .map(routesMain).map({
  [route.layout]: (ctx)=> <MainLayout/>, // layout for all routes in this map and must use <Outlet/>
  // or
  [route.layout]: [moreLayout1, moreLayout2],
  index() {
    return <MainBlogPage />;
  },
  about(ctx) {
    const serverContext = getContext(); // this can be used in server components too
    // type-safe access to route by name + can be used to generate links
    const url = serverContext.router.href("blog.show", {
      slug: ctx.params.slug,
    });
    return <BlogPostPage />;
  },
  // @ts-expect-error unknown route
  another(ctx) {
    //...
  },
})

```

### Route Handlers File

map(..) utility is just for type safety and IDE autocompletion it when we define the map of route separate file.

```typescript
// route.blog.handlers.ts
export default map(routesBlog, {
  [route.layout]: moreLayout1,
  // or
  [route.layout]: [moreLayout1, moreLayout2],
  index() {
    return <MainBlogPage />;
  },
  show(ctx) {
    const serverContext = getContext();
    // type-safe access to route by name
    const url = serverContext.router.href("blog.show", {
      slug: ctx.params.slug,
    });
    return <BlogPostPage />;
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
});

let routesBlog = route({
  index: "/",
  show: "/:slug",
});

let router = createRSCRouter(routes, {
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
    pattern: "/",
  },
  contact: {
    index: {
      pattern: "/contact",
    },
    action: {
      pattern: "/contact",
    },
  },
});
```
