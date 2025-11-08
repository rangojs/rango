# Router API Ideas

## Core Design Principles

### HTTP Method Handling

- **Automatic GET/POST handling**: The router automatically handles GET requests for route handlers. POST requests are handled through RSC actions, eliminating the need for explicit method specifications.
- **API routes**: Method-specific support (PUT, DELETE, PATCH, etc.) will be added later specifically for API endpoints.
- **Convention over configuration**: Routes returning JSX are treated as GET handlers, with RSC actions handling form submissions and mutations.

### Middleware Philosophy

- **Fluent API**: Middleware is applied using chainable `.use()` methods for better composability
- **Explicit ordering**: The order of `.use()` calls determines middleware execution order
- **Scope control**: Middleware can be applied at router, route group, or individual route level

### Route Mounting

- **Path prefixes**: Routes can be mounted at specific path prefixes using `.route(path, routeMap)`
- **Root mounting**: Use `.route(routeMap)` to mount routes without a prefix (at root level)
- **Automatic path composition**: When mounting routes with a prefix, all route paths are relative to that prefix
- **Clean separation**: Define route patterns relative to their logical grouping, mount them at the appropriate URL prefix

---

## Architectural Decisions

### Performance-First Design for Serverless

#### Router Implementation: Hono's Linear Router

We will use **Hono's linear router matcher** as the underlying routing engine. This decision is driven by:

- **Lazy evaluation**: Linear matching with lazy evaluation is optimal for serverless environments where cold starts matter
- **Predictable performance**: O(n) complexity with early termination on match, avoiding complex tree traversals
- **Memory efficiency**: Minimal memory footprint compared to radix tree or trie-based routers
- **Serverless-optimized**: Designed specifically for edge computing and serverless constraints

#### Lazy-Everything Philosophy (With Security Exception)

The router is designed for **extremely constrained environments** (Cloudflare Workers, Vercel Edge, AWS Lambda@Edge) where every millisecond and kilobyte matters.

**EXCEPTION**: Middleware is NOT lazy during request processing. While middleware can be lazy-loaded at route registration, it MUST execute synchronously on every request for security. This is the one area where security trumps performance:

```typescript
// ❌ AVOID: Eager initialization
const router = createRSCRouter({
  routes: compileAllRoutes(),        // Pre-compiles everything
  middleware: loadAllMiddleware(),   // Loads all middleware upfront
  handlers: importAllHandlers(),     // Imports everything
});

// ✅ PREFERRED: Lazy initialization
const router = createRSCRouter();

// Routes are registered but NOT compiled until first match
router
  .route("/blog", blogRoutes)
  .use(() => import("./middleware"))  // Lazy middleware import
  .map(() => import("./handlers"));   // Lazy handler import
```

#### Request-Time Optimization Strategies

1. **Zero pre-computation on deploy**: Routes are registered as simple data structures, no regex compilation or tree building
2. **Just-in-time compilation**: Route patterns compile to matchers only on first request to that route
3. **Handler lazy loading**: Route handlers import only when the route matches
4. **Middleware chain construction**: Middleware chains build only for matched routes, not globally
5. **Layout composition**: Layouts resolve only when rendering, not during route registration

```typescript
// Internal implementation approach (simplified)
class RSCRouter {
  private routes: Map<string, LazyRouteConfig> = new Map();
  private compiledMatchers: WeakMap<LazyRouteConfig, CompiledMatcher> = new WeakMap();

  async match(request: Request) {
    const path = new URL(request.url).pathname;

    // Linear scan with lazy compilation
    for (const [pattern, config] of this.routes) {
      // Compile matcher on first use, cache result
      let matcher = this.compiledMatchers.get(config);
      if (!matcher) {
        matcher = this.compilePattern(pattern);  // JIT compilation
        this.compiledMatchers.set(config, matcher);
      }

      if (matcher.test(path)) {
        // Load handler only after match
        const handler = await config.loadHandler();
        const middleware = await config.loadMiddleware();
        return { handler, middleware, params: matcher.extract(path) };
      }
    }
  }
}
```

#### Memory Management

- **Route registration**: Stores minimal metadata (pattern string + lazy loader function)
- **Compiled patterns**: Use WeakMap for automatic garbage collection
- **Handler modules**: Import dynamically, allowing V8 to optimize/deoptimize as needed
- **Middleware instances**: Create fresh instances per request to avoid state pollution

#### Performance Metrics to Optimize

| Metric | Target | Rationale |
|--------|--------|-----------|
| Cold start | < 10ms | Critical for edge/serverless |
| Route matching | < 1ms | Linear scan must be fast |
| First byte time | < 50ms | Including handler import |
| Memory baseline | < 1MB | Before any routes loaded |
| Per-route overhead | < 10KB | Incremental cost per route |

#### Balanced Lazy Loading

While maximizing laziness, we maintain practical balance:

```typescript
// Reasonable eager loading for common cases
app
  .route(mainRoutes)
  .use(logger())  // Logger is lightweight, OK to load eagerly
  .map({
    // Home page handler can be eager - it's hit frequently
    home: HomepageHandler,

    // Less common routes stay lazy
    about: () => import("./about"),
    contact: () => import("./contact"),
  });

// Heavy routes always lazy
app
  .route("/admin", adminRoutes)
  .use(() => import("./auth"))      // Auth middleware is heavy, keep lazy
  .use(() => import("./rbac"))      // RBAC is complex, keep lazy
  .map(() => import("./admin"));    // Admin handlers are large, keep lazy
```

#### Trade-offs Acknowledged

1. **Route matching**: Linear O(n) scan vs O(log n) tree - acceptable for typical route counts (<100)
2. **JIT compilation overhead**: First request to a route pays compilation cost - acceptable for long-lived workers
3. **Type safety**: Some runtime type checking deferred - TypeScript provides compile-time safety
4. **Debugging**: Lazy loading can complicate stack traces - mitigated by source maps

This architecture prioritizes **startup time** and **memory efficiency** over theoretical maximum throughput, which aligns with serverless/edge constraints where:
- Workers have memory limits (128MB-1GB)
- Cold starts directly impact user experience
- CPU time is metered and costly
- Many routes may never be accessed

---

## Partial Rendering Architecture (CRITICAL REQUIREMENT)

### Overview

The router **MUST** support partial rendering of route segments to enable efficient navigation and revalidation in RSC applications. This allows rendering only the changed portions of a route hierarchy, dramatically improving performance and reducing bandwidth.

### Route Segment Structure

Every route is composed of indexed segments that can be individually rendered:

```typescript
// Route: /blog/123/author/456
// Full render produces:
[
  L0: RootLayout,           // Root layout (if present)
  L1: RootLayout2,          // Additional root layouts (if present)
  L2: BlogLayout,           // /blog layout
  R3: BlogPost,             // /blog/:id content
  L4: AuthorLayout,         // /blog/:id/author layout
  R5: AuthorProfile         // /blog/:id/author/:id content
]
```

### Partial Rendering Protocol

#### Query Parameter Syntax

Use the `_routes` query parameter with index-based notation:

- **`L{n}`**: Layout at index n
- **`R{n}`**: Route content at index n
- **`:`**: Range operator (inclusive)
- **`,`**: Multiple segments separator
- **`@`**: Named slot prefix for parallel routes

#### Examples

```typescript
// Render only the author section (layout + content)
GET /blog/123/author/456?_routes=L4:R5

// Render only the author content (layout unchanged)
GET /blog/123/author/789?_routes=R5

// Render multiple specific segments
GET /blog/123/author/456?_routes=L2,R5

// Render a range
GET /blog/123/author/456?_routes=L2:R5

// Render named slots
GET /blog/123?_routes=R3,@sidebar,@modal
```

### Implementation Requirements

#### 1. Segment Indexing

Routes must maintain a consistent index mapping:

```typescript
interface RouteSegment {
  index: number;
  type: 'layout' | 'content' | 'error' | 'loading';
  path: string;
  component: () => Promise<JSX.Element>;
  params: Record<string, string>;
  slot?: string; // For parallel routes (@sidebar, @modal)
}

class RSCRouter {
  private segmentMap: Map<string, RouteSegment[]> = new Map();

  private buildSegmentMap(pathname: string): RouteSegment[] {
    const segments: RouteSegment[] = [];
    let index = 0;

    // Add root layouts
    for (const layout of this.rootLayouts) {
      segments.push({
        index: index++,
        type: 'layout',
        path: '/',
        component: layout,
        params: {}
      });
    }

    // Build segments for each path part
    const parts = pathname.split('/').filter(Boolean);
    let currentPath = '';

    for (const part of parts) {
      currentPath += `/${part}`;

      // Add layouts for this segment
      const layouts = this.getLayoutsForPath(currentPath);
      for (const layout of layouts) {
        segments.push({
          index: index++,
          type: 'layout',
          path: currentPath,
          component: layout,
          params: this.extractParams(currentPath)
        });
      }

      // Add content for this segment
      const content = this.getContentForPath(currentPath);
      if (content) {
        segments.push({
          index: index++,
          type: 'content',
          path: currentPath,
          component: content,
          params: this.extractParams(currentPath)
        });
      }
    }

    return segments;
  }
}
```

#### 2. Path Change Detection for Layout Persistence

Layouts persist when navigating between routes with the same path structure:

```typescript
interface RevalidationContext {
  currentPath: string;
  nextPath: string;
  currentSegments: RouteSegment[];
  nextSegments: RouteSegment[];
}

class LayoutRevalidation {
  shouldRevalidateLayout(ctx: RevalidationContext, layoutIndex: number): boolean {
    const currentLayout = ctx.currentSegments[layoutIndex];
    const nextLayout = ctx.nextSegments[layoutIndex];

    // Layout doesn't exist in new route
    if (!nextLayout) return false;

    // Path structure changed (e.g., /blog/1 to /blog/2)
    const currentPathPattern = this.getPathPattern(currentLayout.path);
    const nextPathPattern = this.getPathPattern(nextLayout.path);

    if (currentPathPattern !== nextPathPattern) {
      return true; // Different route structure, revalidate
    }

    // Same structure but different params (e.g., /blog/1 to /blog/2)
    // Layout persists, only content revalidates
    const paramKeys = Object.keys(currentLayout.params);
    const significantParamChanged = paramKeys.some(key => {
      return currentLayout.params[key] !== nextLayout.params[key] &&
             this.isLayoutSensitiveParam(key);
    });

    return significantParamChanged;
  }

  private getPathPattern(path: string): string {
    // Convert /blog/123 to /blog/:id pattern
    return path.replace(/\/\d+/g, '/:id')
               .replace(/\/[a-f0-9-]{36}/g, '/:uuid'); // UUIDs
  }
}
```

#### 3. Named Slots for Parallel Routes

Support rendering multiple components at the same route level:

```typescript
// Route definition with parallel routes
let routes = route({
  dashboard: {
    path: "/dashboard",
    slots: {
      "@main": "/dashboard",
      "@sidebar": "/dashboard",
      "@modal": "/dashboard"
    }
  }
});

// Route handlers
app.route(routes.dashboard).map({
  // Main content
  index: () => <DashboardContent />,

  // Named slots
  "@sidebar": () => <DashboardSidebar />,
  "@modal": () => <DashboardModal />,
});

// Partial rendering of slots
// GET /dashboard?_routes=@sidebar
// Only re-renders the sidebar component

// Multiple slots
// GET /dashboard?_routes=@sidebar,@modal
// Re-renders both sidebar and modal
```

#### 4. Loading and Error Boundaries per Segment

Each segment supports its own loading and error boundaries:

```typescript
interface SegmentBoundaries {
  loading?: () => JSX.Element;
  error?: (error: Error) => JSX.Element;
}

// Route configuration with boundaries
app.route("/blog", blogRoutes).map({
  [route.layout]: BlogLayout,
  [route.loading]: BlogLoading,    // L2.loading
  [route.error]: BlogError,        // L2.error

  index: () => <BlogList />,       // R3

  // Nested route with its own boundaries
  post: {
    [route.loading]: PostLoading,  // R4.loading
    [route.error]: PostError,      // R4.error
    handler: (ctx) => <BlogPost id={ctx.params.id} />
  }
});

// During partial render with error
// GET /blog/123?_routes=R4
// If R4 throws, R4.error boundary handles it
// Without affecting L2 or other segments
```

### Middleware Execution During Partial Rendering (CRITICAL)

**IMPORTANT**: Middleware MUST execute on every request, regardless of whether it's a full or partial render. This is non-negotiable for security.

```typescript
class PartialRenderer {
  async render(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CRITICAL: Middleware runs FIRST, always, before any rendering decisions
    const middlewareChain = this.buildMiddlewareChain(pathname);
    const middlewareResult = await this.runMiddleware(request, middlewareChain);

    if (middlewareResult.redirect) {
      return middlewareResult.response; // Early return for redirects
    }

    if (middlewareResult.blocked) {
      return new Response('Forbidden', { status: 403 });
    }

    // Only AFTER middleware passes do we check partial rendering
    const routes = url.searchParams.get('_routes');

    if (!routes) {
      return this.fullRender(request, middlewareResult.context);
    }

    // Partial render proceeds with middleware context
    return this.partialRender(request, routes, middlewareResult.context);
  }

  private buildMiddlewareChain(pathname: string): Middleware[] {
    const chain: Middleware[] = [];

    // Global middleware always runs
    chain.push(...this.globalMiddleware);

    // Route-specific middleware for ALL segments in path
    // Even if only rendering R5, middleware for L0-L4 must run
    const segments = this.getFullRouteSegments(pathname);
    for (const segment of segments) {
      chain.push(...segment.middleware);
    }

    return chain;
  }
}
```

#### Security Implications

1. **Authentication**: Auth middleware runs even for partial renders
2. **Authorization**: Role checks execute for every segment access
3. **Rate Limiting**: Applied consistently across all render types
4. **CORS**: Headers set regardless of render scope
5. **Logging/Audit**: Complete trail for all requests

```typescript
// Example: Admin route with authentication
app
  .route("/admin", adminRoutes)
  .use(authenticate())     // Runs on EVERY request to /admin/*
  .use(requireRole('admin')) // Even for ?_routes=R5
  .use(auditLog())         // Logs all access attempts
  .map({
    users: () => <UserList />,
    settings: () => <Settings />
  });

// Request: GET /admin/users?_routes=R3
// Execution order:
// 1. authenticate() - MUST PASS
// 2. requireRole('admin') - MUST PASS
// 3. auditLog() - LOGS REQUEST
// 4. THEN render only R3 (UserList component)
```

### Partial Rendering Flow

```typescript
class PartialRenderer {
  async render(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routes = url.searchParams.get('_routes');

    // Middleware has already run before this point
    if (!routes) {
      // Full page render
      return this.fullRender(request);
    }

    // Parse partial render instructions
    const segments = this.parseRouteSegments(routes);
    const pathname = url.pathname;
    const fullSegmentMap = this.buildSegmentMap(pathname);

    // Filter to requested segments
    const segmentsToRender = this.filterSegments(fullSegmentMap, segments);

    // Render with boundaries
    const rendered = await this.renderSegments(segmentsToRender, {
      wrapInBoundaries: true,
      streaming: true
    });

    // Return RSC payload (not full HTML document)
    return new Response(rendered, {
      headers: {
        'Content-Type': 'application/x-rsc',
        'X-Rendered-Segments': segments
      }
    });
  }

  private parseRouteSegments(routes: string): SegmentSelector[] {
    // Parse "L2:R5" or "L2,R5" or "@sidebar"
    const selectors: SegmentSelector[] = [];
    const parts = routes.split(',');

    for (const part of parts) {
      if (part.includes(':')) {
        // Range selector
        const [start, end] = part.split(':');
        selectors.push({ type: 'range', start, end });
      } else if (part.startsWith('@')) {
        // Named slot
        selectors.push({ type: 'slot', name: part });
      } else {
        // Single segment
        selectors.push({ type: 'single', id: part });
      }
    }

    return selectors;
  }
}
```

### Navigation Examples

#### Initial Navigation
```typescript
// User navigates to /blog/123/author/456
// Full render (no _routes param)
GET /blog/123/author/456

Response segments:
L0: RootLayout
L1: BlogLayout
R2: BlogPost(id=123)
L3: AuthorLayout
R4: AuthorProfile(id=456)
```

#### Navigate to Different Author
```typescript
// User clicks to view different author
// Only author content changes, layout persists
GET /blog/123/author/789?_routes=R4

Response segments:
R4: AuthorProfile(id=789)  // Only this renders
```

#### Navigate to Different Blog Post
```typescript
// User navigates to different blog post
// Blog layout persists, content and nested routes change
GET /blog/456/author/789?_routes=R2:R4

Response segments:
R2: BlogPost(id=456)
L3: AuthorLayout         // Re-render due to parent change
R4: AuthorProfile(id=789)
```

#### Revalidate Specific Layout
```typescript
// Force revalidation of blog layout only
GET /blog/123/author/456?_routes=L1

Response segments:
L1: BlogLayout  // Only layout re-renders
```

### Performance Optimizations

1. **Segment Caching**: Cache rendered segments with cache keys based on path + params
2. **Predictive Prefetching**: Prefetch likely segments based on user patterns
3. **Streaming**: Stream partial segments as they become ready
4. **Delta Compression**: Send only changed props for persisted layouts

```typescript
// Implementation must support streaming partial renders
const stream = new ReadableStream({
  async start(controller) {
    for (const segment of segmentsToRender) {
      const rendered = await renderSegment(segment);
      controller.enqueue(encodeRSCChunk(segment.index, rendered));
    }
    controller.close();
  }
});

return new Response(stream, {
  headers: { 'Content-Type': 'application/x-rsc-stream' }
});
```

### Critical Implementation Notes

1. **Middleware Execution**: Middleware MUST run on EVERY request, regardless of partial/full render - this is critical for security
2. **Consistency**: Segment indices MUST remain consistent across renders
3. **State Preservation**: Persisted layouts must maintain their state
4. **Error Isolation**: Errors in one segment must not affect others
5. **Progressive Enhancement**: Full render fallback if partial rendering fails
6. **Type Safety**: TypeScript must enforce valid segment references
7. **Security First**: Never bypass middleware for performance - security checks are non-negotiable

This partial rendering system is **MANDATORY** for the router implementation and must be considered in all architectural decisions. The combination of always-running middleware with partial rendering ensures both security and performance.

---

## Multiple Route Files with Route-Level Metadata

### Basic Route Definition

```typescript
import { createRSCRouter, route, layout } from "rsc-router";
// middleware, layout are special symbols used to define route-level metadata

// `route()` creates a "route map" that organizes routes by name. The keys
// of the map may be any name, and may be nested to group related routes.
let routesMain = route({
  home: "/",
  about: "/about",
});

// Define blog routes relative to their mount point
let routesBlog = route({
  index: "/",        // Will become /blog when mounted at /blog
  show: "/:slug",    // Will become /blog/:slug when mounted at /blog
});

let app = createRSCRouter({
  // other configs TBD
});

// Map the routes to "handlers" for each route. The structure of the route
// handlers object mirrors the structure of the route map, with full type safety.
// Mount blog routes at /blog prefix
app
  .route("/blog", routesBlog)
  .use(auth()) // Apply auth middleware
  .use(blogTracker()) // Apply tracking middleware
  .use(async (ctx, next) => {
    // Custom inline middleware
    console.log("Blog route accessed");
    return next();
  })
  // Lazy middleware import
  .use(() => import("route.blog.middleware"))
  .map(() => import("route.blog.handlers"));

// Main routes mounted at root (no prefix)
app
  .route(routesMain)
  .use(logger()) // Apply logging to main routes
  .map({
    [route.layout]: (ctx) => <MainLayout />, // layout for all routes in this map and must use <Outlet/>
    // or
    [route.layout]: [moreLayout1, moreLayout2],

    // GET request handler (automatic)
    home() {
      return <HomePage />;
    },

    // GET request handler with context
    about(ctx) {
      const serverContext = getContext(); // this can be used in server components too
      // type-safe access to route by name + can be used to generate links
      const url = serverContext.router.href("blog.show", {
        slug: "example-post",
      });
      return <AboutPage linkToBlog={url} />;
    },

    // @ts-expect-error unknown route
    another(ctx) {
      //...
    },
  });
```

### Route Handlers File

`map(..)` utility is just for type safety and IDE autocompletion when we define the map of routes in a separate file.

```typescript
// route.blog.handlers.ts
export default map(routesBlog, {
  [route.layout]: BlogLayout,
  // or
  [route.layout]: [BlogLayout, BlogSidebar],

  // GET /blog - automatically handles GET requests (mounted at /blog)
  index() {
    return <BlogIndexPage />;
  },

  // GET /blog/:slug - automatically handles GET requests (mounted at /blog)
  show(ctx) {
    const serverContext = getContext();
    // type-safe access to route by name
    const url = serverContext.router.href("blog.index");
    return <BlogPostPage slug={ctx.params.slug} backUrl={url} />;
  },
});
```

---

## Single File with Route-Level Metadata

### Complete Route Configuration

```typescript
import { createRSCRouter, route, layout } from "rsc-router";
// middleware, layout are special symbols used to define route-level metadata

// `route()` creates a "route map" that organizes routes by name. The keys
// of the map may be any name, and may be nested to group related routes.
let routesMain = route({
  home: "/",
  about: "/about",
  contact: "/contact",
});

let routesBlog = route({
  index: "/",
  show: "/:slug",
  create: "/new",
});

let app = createRSCRouter({
  // other configs TBD
});

// Global middleware applied to all routes
app
  .use(logger()) // Request logging
  .use(requestId()) // Add request ID for tracing
  .use(securityHeaders()); // Security headers

// Blog routes with specific middleware chain
app
  .route("/blog", routesBlog)
  .use(auth()) // Authentication required for blog routes
  .use(rateLimit()) // Rate limiting for blog
  .map(() => import("route.blog.handlers"));

// Main routes configuration
app.route(routesMain).map({
  [route.loading]: {
    contact: () => import("main/loading").then((m) => m.ContactLoading),
  },

  [route.layout]: () => import("main/layout").then((m) => m.MainLayout),

  [route.revalidate]: {
    [route.layout]: (ctx) => true,

    home: (ctx) => {
      // Context object shape:
      // {
      //   currentPath,
      //   nextPath,
      //   currentRouteName,
      //   nextRouteName,
      //   params,
      //   actionData,
      //   request,
      //   actionParams,
      // }

      // Revalidate home only when coming from a different route
      return ctx.currentRouteName !== "home";
    },
  },

  // GET / - returns JSX, automatically handled as GET
  home() {
    return <HomePage />;
  },

  // GET /about
  about() {
    return <AboutPage />;
  },

  // GET /contact - Form submissions handled by RSC actions
  contact() {
    return <ContactForm />;
  },
});
```

---

## Route Mounting Patterns

### Mounting Routes at Specific Paths

Routes can be mounted at specific URL prefixes, allowing for clean organization and relative path definitions:

```typescript
// Define routes relative to their logical grouping
let authRoutes = route({
  login: "/login",
  register: "/register",
  logout: "/logout",
  profile: "/profile",
});

let adminRoutes = route({
  index: "/",           // Will become /admin
  users: "/users",      // Will become /admin/users
  posts: "/posts",      // Will become /admin/posts
  settings: "/settings", // Will become /admin/settings
});

let apiV1Routes = route({
  users: "/users",      // Will become /api/v1/users
  posts: "/posts",      // Will become /api/v1/posts
});

let apiV2Routes = route({
  users: "/users",      // Will become /api/v2/users
  posts: "/posts",      // Will become /api/v2/posts
  comments: "/comments", // Will become /api/v2/comments
});

let app = createRSCRouter();

// Mount authentication routes at root level
app
  .route(authRoutes)
  .use(rateLimiter())
  .map({
    login: () => <LoginPage />,
    register: () => <RegisterPage />,
    logout: () => <LogoutPage />,
    profile: () => <ProfilePage />,
  });

// Mount admin routes under /admin prefix
app
  .route("/admin", adminRoutes)
  .use(auth())
  .use(requireRole("admin"))
  .map({
    [route.layout]: AdminLayout,
    index: () => <AdminDashboard />,
    users: () => <UsersManagement />,
    posts: () => <PostsManagement />,
    settings: () => <AdminSettings />,
  });

// Mount API versions at different prefixes
app
  .route("/api/v1", apiV1Routes)
  .use(cors())
  .use(apiAuth())
  .map(() => import("./api/v1/handlers"));

app
  .route("/api/v2", apiV2Routes)
  .use(cors())
  .use(apiAuth())
  .use(compression())
  .map(() => import("./api/v2/handlers"));
```

### Nested Mount Points

You can also create deeply nested route structures:

```typescript
// Define shop-related routes
let shopRoutes = route({
  products: {
    list: "/products",
    detail: "/products/:id",
  },
  cart: "/cart",
  checkout: "/checkout",
});

let shopAdminRoutes = route({
  inventory: "/inventory",
  orders: "/orders",
  analytics: "/analytics",
});

// Mount shop routes at /shop
app
  .route("/shop", shopRoutes)
  .use(shopMiddleware())
  .map({
    products: {
      list: () => <ProductList />,
      detail: (ctx) => <ProductDetail id={ctx.params.id} />,
    },
    cart: () => <ShoppingCart />,
    checkout: () => <CheckoutPage />,
  });

// Mount shop admin routes at /shop/admin (nested prefix)
app
  .route("/shop/admin", shopAdminRoutes)
  .use(auth())
  .use(requireRole("shop-admin"))
  .map({
    inventory: () => <InventoryManagement />,
    orders: () => <OrdersManagement />,
    analytics: () => <ShopAnalytics />,
  });
```

---

## Advanced Patterns

### Nested Route Groups with Middleware

```typescript
// Define nested route structure
let routes = route({
  public: {
    home: "/",
    about: "/about",
  },
  admin: {
    dashboard: "/admin",
    users: "/admin/users",
    settings: "/admin/settings",
  },
  api: {
    health: "/api/health",
    metrics: "/api/metrics",
  },
});

let app = createRSCRouter();

// Public routes - no authentication required
app
  .route(routes.public)
  .use(cacheHeaders({ maxAge: 3600 }))
  .map({
    home: () => <HomePage />,
    about: () => <AboutPage />,
  });

// Admin routes - authentication and authorization required
app
  .route(routes.admin)
  .use(auth())
  .use(requireRole("admin"))
  .use(auditLog())
  .map({
    [route.layout]: AdminLayout,

    dashboard: () => <AdminDashboard />,
    users: () => <UserManagement />,
    settings: () => <AdminSettings />,
  });

// API routes - will support explicit HTTP methods in future
app
  .route(routes.api)
  .use(cors())
  .use(apiRateLimit())
  .map({
    // Currently returns JSON responses for GET requests
    health: () => Response.json({ status: "ok" }),
    metrics: async () => {
      const metrics = await collectMetrics();
      return Response.json(metrics);
    },
  });
```

### Data Loading and RSC Integration

```typescript
let routes = route({
  products: {
    list: "/products",
    detail: "/products/:id",
    edit: "/products/:id/edit",
  },
});

app
  .route(routes.products)
  .use(auth())
  .map({
    // GET /products - list all products
    list: async () => {
      const products = await db.products.findAll();
      return <ProductList products={products} />;
    },

    // GET /products/:id - show product details
    detail: async (ctx) => {
      const product = await db.products.findById(ctx.params.id);
      return <ProductDetail product={product} />;
    },

    // GET /products/:id/edit - show edit form
    // Form submissions and mutations handled by RSC actions
    edit: async (ctx) => {
      const product = await db.products.findById(ctx.params.id);
      return <ProductEditForm product={product} />;
    },
  });
```

### Working with RSC Actions

RSC actions handle all form submissions and mutations automatically. The router focuses on URL routing and data loading, while RSC actions manage state mutations.

```typescript
// In your components, use RSC actions for mutations
// ProductEditForm.tsx
async function updateProduct(formData: FormData) {
  "use server";

  const productId = formData.get("id");
  const validation = validateProduct(formData);

  if (!validation.success) {
    return { error: validation.error };
  }

  await db.products.update(productId, validation.data);
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}`);
}

export function ProductEditForm({ product }) {
  return (
    <form action={updateProduct}>
      <input type="hidden" name="id" value={product.id} />
      {/* Form fields */}
      <button type="submit">Save Changes</button>
    </form>
  );
}
```

---

## Future: API Routes with HTTP Methods

_Note: This section describes future functionality for API endpoints_

```typescript
// Future API route definition with explicit HTTP methods
let apiRoutes = route({
  users: {
    list: "/api/users",
    detail: "/api/users/:id",
  },
});

// Future syntax for API routes with method-specific handlers
app
  .route(apiRoutes)
  .use(apiAuth())
  .use(jsonBody())
  .mapAPI({
    users: {
      list: {
        GET: async () => {
          const users = await db.users.findAll();
          return Response.json(users);
        },
        POST: async (ctx) => {
          const body = await ctx.request.json();
          const user = await db.users.create(body);
          return Response.json(user, { status: 201 });
        },
      },
      detail: {
        GET: async (ctx) => {
          const user = await db.users.findById(ctx.params.id);
          return Response.json(user);
        },
        PUT: async (ctx) => {
          const body = await ctx.request.json();
          const user = await db.users.update(ctx.params.id, body);
          return Response.json(user);
        },
        DELETE: async (ctx) => {
          await db.users.delete(ctx.params.id);
          return new Response(null, { status: 204 });
        },
      },
    },
  });
```
