---
name: route
description: Define basic routes and route handlers in @rangojs/router
argument-hint: [route-name]
---

# Basic Route Definition

## Route Definition (routes.ts)

Define type-safe routes using the `route()` function:

```typescript
import { route } from "@rangojs/router";

export const routes = route({
  index: "/",
  about: "/about",
  // Dynamic params
  product: "/products/:id",
  // Nested routes
  blog: {
    index: "/blog",
    post: "/blog/:slug",
    category: "/blog/category/:category",
  },
  // Optional params
  search: "/search/:query?",
  // Constrained params
  locale: "/:locale(en|de|fr)",
});
```

### Parameter Types

| Pattern | Example | Description |
|---------|---------|-------------|
| `:id` | `/products/:id` | Required parameter |
| `:page?` | `/list/:page?` | Optional parameter |
| `:locale(en\|de)` | `/:locale(en\|de)` | Constrained values |
| `:lang(en\|de)?` | `/:lang(en\|de)?` | Optional + constrained |

## Route Handler (handlers/*.tsx)

Use the `map()` function to define handlers:

```typescript
import { map } from "@rangojs/router/server";
import type { routes } from "../routes.js";

export default map<typeof routes>(({ route, loader, loading, revalidate }) => [
  // Simple route
  route("index", () => <HomePage />),

  // Route with params
  route("product", (ctx) => {
    return <ProductPage id={ctx.params.id} />;
  }),

  // Route with loader
  route("blog.post", async (ctx) => {
    const post = await ctx.use(PostLoader);
    return <BlogPost post={post} />;
  }, () => [
    loader(PostLoader),
    loading(<PostSkeleton />),
  ]),
]);
```

## Handler Context

The `ctx` object provides:

```typescript
route("product", (ctx) => {
  ctx.params        // Type-safe route parameters { id: string }
  ctx.query         // Query string parameters
  ctx.url           // Full URL object
  ctx.pathname      // Current pathname
  ctx.method        // HTTP method (GET, POST, etc.)
  ctx.request       // Raw Request object

  // Data fetching
  const data = await ctx.use(MyLoader);

  // Handle accumulation
  const push = ctx.use(BreadcrumbHandle);
  push({ label: "Product", href: ctx.pathname });

  // Context variables (set by middleware)
  const user = ctx.get("user");

  return <ProductPage />;
});
```

## Router Registration (router.tsx)

Register routes with the router:

```typescript
import { createRSCRouter } from "@rangojs/router/server";
import { routes } from "./routes.js";

const router = createRSCRouter<AppEnv>({
  document: RootLayout,
})
  .routes("/", routes)
  .map(() => import("./handlers/main.js"));

export default router;
```

## Type-Safe Links

Use the generated `href` function:

```typescript
import { href } from "./router.js";

// Type-safe href generation
<Link href={href("product", { id: "123" })} />
<Link href={href("blog.post", { slug: "hello-world" })} />

// With query params
<Link href={href("search", { query: "test" }, { page: "2" })} />
```

## Route Configuration Options

```typescript
route("product", ProductHandler, () => [
  loader(ProductLoader),           // Attach data loader
  loading(<Skeleton />),           // Loading UI
  revalidate(revalidateFn),        // Cache control
  errorBoundary(<ErrorFallback />), // Error handling
  notFoundBoundary(<NotFound />),   // 404 handling
  parallel({ "@sidebar": Sidebar }), // Parallel slots
])
```
