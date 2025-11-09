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

### Layout Composition

- **Single Layout**: `[route.layout]: BlogLayout` - Simple single layout wrapper
- **Multiple Layouts**: `[route.layout]: [RootLayout, AppShell, BlogLayout]` - Nested layouts applied in order (outer to inner)
- **Layout Nesting**: Each layout in the array wraps the next, with the last wrapping the content
- **Outlet Usage**: Every layout uses `<Outlet />` to render its child content

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
  routes: compileAllRoutes(), // Pre-compiles everything
  middleware: loadAllMiddleware(), // Loads all middleware upfront
  handlers: importAllHandlers(), // Imports everything
});

// ✅ PREFERRED: Lazy initialization
const router = createRSCRouter();

// Routes are registered but NOT compiled until first match
router
  .route("/blog", blogRoutes)
  .use(() => import("./middleware")) // Lazy middleware import
  .map(() => import("./handlers")); // Lazy handler import
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
  private compiledMatchers: WeakMap<LazyRouteConfig, CompiledMatcher> =
    new WeakMap();

  async match(request: Request) {
    const path = new URL(request.url).pathname;

    // Linear scan with lazy compilation
    for (const [pattern, config] of this.routes) {
      // Compile matcher on first use, cache result
      let matcher = this.compiledMatchers.get(config);
      if (!matcher) {
        matcher = this.compilePattern(pattern); // JIT compilation
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

| Metric             | Target | Rationale                    |
| ------------------ | ------ | ---------------------------- |
| Cold start         | < 10ms | Critical for edge/serverless |
| Route matching     | < 1ms  | Linear scan must be fast     |
| First byte time    | < 50ms | Including handler import     |
| Memory baseline    | < 1MB  | Before any routes loaded     |
| Per-route overhead | < 10KB | Incremental cost per route   |

#### Balanced Lazy Loading

While maximizing laziness, we maintain practical balance:

```typescript
// Reasonable eager loading for common cases
app
  .route(mainRoutes)
  .use(logger()) // Logger is lightweight, OK to load eagerly
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
  .use(() => import("./auth")) // Auth middleware is heavy, keep lazy
  .use(() => import("./rbac")) // RBAC is complex, keep lazy
  .map(() => import("./admin")); // Admin handlers are large, keep lazy
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

// When using layout arrays:
// [route.layout]: [AppShell, BlogLayout, BlogSidebar]
// Produces segments:
[
  L0: AppShell,            // Outermost layout
  L1: BlogLayout,          // Middle layout
  L2: BlogSidebar,         // Innermost layout
  R3: BlogPost             // Content
]
// AppShell's <Outlet /> renders BlogLayout
// BlogLayout's <Outlet /> renders BlogSidebar
// BlogSidebar's <Outlet /> renders BlogPost
```

### Server-Client Segment Rendering Architecture

#### Core Principle: Client Reports, Server Computes

The client doesn't know routing logic or what segments it needs - it only knows what segments it currently has rendered. The server is responsible for computing what needs to be sent based on the navigation target and the client's current state.

**Key Architecture Points:**

- Server renders segments bottom-up using OutletContext
- Client tracks rendered segment IDs (L0, R1, P2, etc.)
- Segment types: L (layout), R (route content), P (parallel route with @name)
- Layouts can be arrays: `[route.layout]: [Layout1, Layout2]` creates multiple L segments
- Parallel routes use `[route.parallel]`: defines P segments like @sidebar, @modal
- On navigation, client sends `_has` parameter with current segments
- Server always responds with complete segment list for reconciliation
- Server computes differential and returns only needed updates
- Client reconciles by comparing its segments with server's list

#### Server-Side Rendering with OutletContext

On the server, segments are rendered hierarchically and passed through OutletContext. This bottom-up rendering approach allows parent layouts to receive pre-rendered children.

**Note: Server and client handle segment composition differently:**

- **Server**: Renders bottom-up, each segment has access to pre-rendered children via context
- **Client**: Stores segments flat, `<Outlet />` component knows how to access the next segment

```typescript
// Server renders child segments and makes them available to parents
class ServerRenderer {
  async renderSegment(segment: RouteSegment, childContent?: ReactNode) {
    // Set up context for this segment
    // Outlet component will internally access this context
    const context = {
      children: childContent, // Pre-rendered child segments
      params: segment.params,
      pathname: segment.path,
    };

    // Render segment - Outlet inside will access context
    const Component = await segment.component();
    return (
      <SegmentContext.Provider value={context}>
        <Component />
      </SegmentContext.Provider>
    );
  }

  async renderFullRoute(pathname: string) {
    const segments = this.buildSegmentMap(pathname);
    let rendered = null;

    // Render from deepest to root (bottom-up)
    // This ensures children are rendered before parents
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      rendered = await this.renderSegment(segment, rendered);
    }

    return rendered;
  }
}

// Example Layout Component
function BlogLayout() {
  return (
    <div className="blog-layout">
      <BlogHeader />
      <main>
        {/* Outlet automatically renders the next segment */}
        <Outlet />
      </main>
      <BlogFooter />
    </div>
  );
}
```

#### Client State Communication Protocol for SPA Navigation

During SPA (Single Page Application) navigation, the client communicates its current rendered segments using the `_has` query parameter. This enables efficient updates without full page reloads:

```typescript
// Client tracks what segments are currently rendered
interface ClientState {
  renderedSegments: Set<string>; // e.g., Set(['L0', 'L1', 'R2', 'L3', 'R4'])
}

// During navigation, client sends what it has
async function navigateToRoute(pathname: string) {
  const currentSegments = Array.from(clientState.renderedSegments);
  const url = `${pathname}?_has=${currentSegments.join(",")}`;

  const responsePromise = fetch(url, {
    headers: {
      Accept: "application/x-rsc",
    },
  });

  // Use RSC's createFromFetch to process the stream
  const payload = await createFromFetch<RscPayload>(responsePromise);

  // RscPayload contains segments and updates as RSC components
  processPayload(payload);
}

// Process RSC payload
interface RscPayload {
  segments: string[]; // Complete list of segment IDs
  updates: Record<string, ReactNode>; // RSC components for segments
}

function processPayload(payload: RscPayload) {
  const { segments, updates } = payload;
  const shouldExist = new Set(segments);

  // 1. Remove segments not in server list
  for (const id of clientState.renderedSegments) {
    if (!shouldExist.has(id)) {
      removeSegment(id);
    }
  }

  // 2. Update/add segments from RSC payload
  for (const [id, component] of Object.entries(updates)) {
    if (clientState.renderedSegments.has(id)) {
      updateSegment(id, component); // Replace with new RSC component
    } else {
      addSegment(id, component); // Add new RSC component
    }
  }

  // 3. Update client state
  clientState.renderedSegments = shouldExist;
}
```

#### Client-Side Segment Composition with OutletProvider

The client uses React Context to pass segments through the component tree:

```typescript
// Outlet component uses React Context to get its content
const OutletContext = createContext<ReactNode | null>(null);

export function Outlet() {
  const content = useContext(OutletContext);
  return <>{content}</>;
}

// OutletProvider wraps segments and provides content to Outlet
export function OutletProvider({
  children,
  content,
}: {
  children: ReactNode; // The current segment component
  content: ReactNode; // The next segment(s) to render in Outlet
}) {
  return (
    <OutletContext.Provider value={content}>{children}</OutletContext.Provider>
  );
}

// Client builds the segment chain using OutletProvider
// NOTE: Implementation needs correction - should build so each segment's
// Outlet shows the NEXT segment, not previous ones
function reconstructTreeFromSegments(segments: Segment[]): ReactNode {
  if (!segments || segments.length === 0) {
    return null;
  }

  // Build from last to first (innermost to outermost)
  // Each segment wraps the next one(s)
  let tree: ReactNode = null;

  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];

    // Current segment's Outlet will show the accumulated tree (next segments)
    tree = (
      <OutletProvider content={tree} key={`outlet-${segment.index}`}>
        {segment.component}
      </OutletProvider>
    );
  }

  return tree;
}

// Example: Given segments [L0: RootLayout, L1: BlogLayout, R2: BlogPost]
//
// Step 1 (i=2): tree = <OutletProvider content={null}><BlogPost /></OutletProvider>
// Step 2 (i=1): tree = <OutletProvider content={[BlogPost wrapped]}><BlogLayout /></OutletProvider>
// Step 3 (i=0): tree = <OutletProvider content={[BlogLayout+BlogPost wrapped]}><RootLayout /></OutletProvider>
//
// Result: RootLayout is outermost, its Outlet shows BlogLayout,
//         BlogLayout's Outlet shows BlogPost

// When BlogLayout renders <Outlet />, it gets BlogPost from context
function BlogLayout() {
  return (
    <div className="blog-layout">
      <BlogHeader />
      <main>
        <Outlet /> {/* Gets content from OutletContext */}
      </main>
      <BlogFooter />
    </div>
  );
}
```

This approach:

- Uses React Context for clean component composition
- Layouts remain simple with just `<Outlet />`
- OutletProvider handles passing segments through the tree
- Works identically for all layouts regardless of nesting level

#### Server Differential Computation

The server computes what segments need to be sent:

```typescript
class DifferentialRenderer {
  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const clientHas = this.parseClientSegments(url.searchParams.get("_has"));

    // Build target segment map for requested route
    const targetSegments = this.buildSegmentMap(pathname);
    const targetIds = new Set(targetSegments.map((s) => s.id));

    // Compute what needs to be sent
    const toSend = this.computeDifferential(
      clientHas,
      targetIds,
      targetSegments
    );

    // Render only necessary segments
    const rendered = await this.renderSegments(toSend);

    // Create RSC payload with segment information
    const rscPayload = {
      segments: targetSegments.map((s) => s.id), // Complete list of segments
      updates: rendered, // Only segments that need updating (as React components)
    };

    // Return as RSC stream, not JSON
    return new Response(renderToRSCStream(rscPayload), {
      headers: { "Content-Type": "application/x-rsc" },
    });
  }

  private computeDifferential(
    clientHas: Set<string>,
    targetIds: Set<string>,
    targetSegments: RouteSegment[]
  ): RouteSegment[] {
    const toRender: RouteSegment[] = [];

    for (const segment of targetSegments) {
      const shouldSend =
        // Segment doesn't exist on client
        !clientHas.has(segment.id) ||
        // Segment needs revalidation (params changed, etc.)
        this.needsRevalidation(segment, clientHas);

      if (shouldSend) {
        toRender.push(segment);
      }
    }

    return toRender;
  }
}
```

#### Examples

##### Initial Navigation (No Client State)

```typescript
// Client navigates to /blog/123/author/456
GET /blog/123/author/456
// No _has parameter = full render

Server response (RSC Payload):
{
  segments: ['L0', 'L1', 'R2', 'L3', 'R4'],  // Complete segment list
  updates: {  // All segments as RSC components
    L0: <RootLayout />,
    L1: <BlogLayout />,
    R2: <BlogPost id="123" />,
    L3: <AuthorLayout />,
    R4: <AuthorProfile id="456" />
  }
}
// Sent as RSC stream, not JSON
```

##### Subsequent Navigation (With Client State)

```typescript
// Client has L0,L1,R2,L3,R4 rendered
// Navigates to /blog/123/author/789
GET /blog/123/author/789?_has=L0,L1,R2,L3,R4

Server computes:
- L0: No change needed (same root)
- L1: No change needed (same blog layout)
- R2: No change needed (same blog post)
- L3: No change needed (same author layout structure)
- R4: NEEDS UPDATE (different author ID)

Server response (RSC Payload):
{
  segments: ['L0', 'L1', 'R2', 'L3', 'R4'],  // Same structure
  updates: {
    R4: <AuthorProfile id="789" />  // Only R4 as RSC component
  }
}
// Streamed as RSC, client reconciles: keeps L0-L3, updates R4
```

##### Navigation with Structure Change

```typescript
// Client has L0,L1,R2 rendered (on /blog/123)
// Navigates to /blog/123/author/456 (deeper nesting)
GET /blog/123/author/456?_has=L0,L1,R2

Server computes:
- L0: Already has
- L1: Already has
- R2: Already has
- L3: NEW - needs to send
- R4: NEW - needs to send

Server response (RSC Payload):
{
  segments: ['L0', 'L1', 'R2', 'L3', 'R4'],  // Extended structure
  updates: {
    L3: <AuthorLayout />,      // New segment as RSC
    R4: <AuthorProfile id="456" />  // New segment as RSC
  }
}
// Streamed as RSC, client reconciles: keeps L0-L2, adds L3-R4
```

### Implementation Requirements

#### 1. Segment Indexing

Routes must maintain a consistent index mapping:

```typescript
interface RouteSegment {
  index: number;
  type: "layout" | "content" | "error" | "loading";
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
        type: "layout",
        path: "/",
        component: layout,
        params: {},
      });
    }

    // Build segments for each path part
    const parts = pathname.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;

      // Add layouts for this segment
      const layouts = this.getLayoutsForPath(currentPath);
      for (const layout of layouts) {
        segments.push({
          index: index++,
          type: "layout",
          path: currentPath,
          component: layout,
          params: this.extractParams(currentPath),
        });
      }

      // Add content for this segment
      const content = this.getContentForPath(currentPath);
      if (content) {
        segments.push({
          index: index++,
          type: "content",
          path: currentPath,
          component: content,
          params: this.extractParams(currentPath),
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
  shouldRevalidateLayout(
    ctx: RevalidationContext,
    layoutIndex: number
  ): boolean {
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
    const significantParamChanged = paramKeys.some((key) => {
      return (
        currentLayout.params[key] !== nextLayout.params[key] &&
        this.isLayoutSensitiveParam(key)
      );
    });

    return significantParamChanged;
  }

  private getPathPattern(path: string): string {
    // Convert /blog/123 to /blog/:id pattern
    return path.replace(/\/\d+/g, "/:id").replace(/\/[a-f0-9-]{36}/g, "/:uuid"); // UUIDs
  }
}
```

#### 3. Parallel Routes (Named Slots)

Support rendering multiple components at the same route level using `[route.parallel]`:

```typescript
// Route definition
let routes = route({
  dashboard: "/dashboard",
});

// Route handlers with parallel routes
app.route(routes.dashboard).map({
  // Main content
  index: () => <DashboardContent />,

  // Parallel routes using [route.parallel]
  [route.parallel]: {
    "@sidebar": () => <DashboardSidebar />,
    "@modal": () => <DashboardModal />,
    "@header": () => <DashboardHeader />,
  },
});

// Partial rendering of parallel routes
// GET /dashboard?_routes=@sidebar
// Only re-renders the sidebar component

// Multiple parallel routes
// GET /dashboard?_routes=@sidebar,@modal
// Re-renders both sidebar and modal

// All parallel routes render together with main content
// GET /dashboard
// Renders: index + @sidebar + @modal + @header
```

### Complete Example with Layouts and Parallel Routes

```typescript
let routes = route({
  dashboard: "/dashboard",
  settings: "/dashboard/settings",
});

app.route(routes.dashboard).map({
  // Can combine array layouts with parallel routes
  [route.layout]: [AppShell, DashboardLayout],

  // Main content
  index: () => <DashboardMain />,

  // Parallel routes render alongside main content
  [route.parallel]: {
    "@sidebar": () => <DashboardSidebar />,
    "@notifications": () => <NotificationPanel />,
  },
});

// Segment structure for /dashboard:
// L0: AppShell
// L1: DashboardLayout
// R2: DashboardMain
// P3: @sidebar (DashboardSidebar)
// P4: @notifications (NotificationPanel)
// P-segments (parallel) render at the same level as R-segments
```

### Per-Route Layouts and Parallel Routes

Both layouts and parallel routes can be defined **per route** for maximum flexibility:

```typescript
let routes = route({
  home: "/",
  about: "/about",
  dashboard: "/dashboard",
});

app.route(routes).map({
  // Per-route layouts (type-safe route names)
  [route.layout]: {
    home: [RootLayout, HomeLayout],
    about: [RootLayout, AboutLayout],
    dashboard: [RootLayout, DashboardLayout],
  },

  // Per-route parallel routes (type-safe route names)
  [route.parallel]: {
    home: {
      "@sidebar": () => <HomeSidebar />,
    },
    dashboard: {
      "@sidebar": () => <DashboardSidebar />,
      "@notifications": () => <NotificationPanel />,
    },
    // 'about' has no parallel routes
  },

  // Route handlers
  home: () => <HomePage />,
  about: () => <AboutPage />,
  dashboard: () => <DashboardMain />,
});
```

**Benefits**:
- Each route can have different layouts
- Each route can have different parallel routes
- Type-safe: route names must match those in route map
- Flexible: some routes can omit layouts or parallel routes
- Clean: all configuration in one place

**Alternative: Global + Per-Route Mixed**
```typescript
app.route(routes).map({
  // Global layout for all routes
  [route.layout]: RootLayout,

  // Per-route additional layouts
  [route.layout]: {
    dashboard: [RootLayout, DashboardLayout],  // Overrides global
    about: RootLayout,  // Uses global
  },

  home: () => <HomePage />,
  about: () => <AboutPage />,
  dashboard: () => <DashboardMain />,
});
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
  [route.loading]: BlogLoading, // L2.loading
  [route.error]: BlogError, // L2.error

  index: () => <BlogList />, // R3

  // Nested route with its own boundaries
  post: {
    [route.loading]: PostLoading, // R4.loading
    [route.error]: PostError, // R4.error
    handler: (ctx) => <BlogPost id={ctx.params.id} />,
  },
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
      return new Response("Forbidden", { status: 403 });
    }

    // Only AFTER middleware passes do we check partial rendering
    const routes = url.searchParams.get("_routes");

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
  .use(authenticate()) // Runs on EVERY request to /admin/*
  .use(requireRole("admin")) // Even for ?_routes=R5
  .use(auditLog()) // Logs all access attempts
  .map({
    users: () => <UserList />,
    settings: () => <Settings />,
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
    const routes = url.searchParams.get("_routes");

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
      streaming: true,
    });

    // Return RSC payload (not full HTML document)
    return new Response(rendered, {
      headers: {
        "Content-Type": "application/x-rsc",
        "X-Rendered-Segments": segments,
      },
    });
  }

  private parseRouteSegments(routes: string): SegmentSelector[] {
    // Parse "L2:R5" or "L2,R5" or "@sidebar"
    const selectors: SegmentSelector[] = [];
    const parts = routes.split(",");

    for (const part of parts) {
      if (part.includes(":")) {
        // Range selector
        const [start, end] = part.split(":");
        selectors.push({ type: "range", start, end });
      } else if (part.startsWith("@")) {
        // Named slot
        selectors.push({ type: "slot", name: part });
      } else {
        // Single segment
        selectors.push({ type: "single", id: part });
      }
    }

    return selectors;
  }
}
```

### Client-Server Navigation Flow

#### Why Client Reports Instead of Requesting

The client doesn't know the routing structure or what it needs next - it only knows what's currently rendered. This "dumb client, smart server" approach ensures:

- Routing logic stays server-side
- Client code remains minimal
- Server can optimize based on full route knowledge
- Structure changes are handled gracefully

#### Navigation Flow Examples

##### Initial Page Load

```typescript
// First visit - no client state
GET /blog/123/author/456

Server: Full render all segments
Response: L0, L1, R2, L3, R4
Client: Stores segment IDs for future navigation
```

##### Navigate to Different Author

```typescript
// Client currently has: L0,L1,R2,L3,R4
// User clicks to /blog/123/author/789

GET /blog/123/author/789?_has=L0,L1,R2,L3,R4

Server computation:
- Target route needs: L0,L1,R2,L3,R4
- Client has: L0,L1,R2,L3,R4
- Only R4 has different params (789 vs 456)

Response (RSC Payload):
{
  segments: ['L0', 'L1', 'R2', 'L3', 'R4'],
  updates: { R4: <AuthorProfile id="789" /> }
}
// Streamed as RSC via createFromFetch
Client: Reconciles - keeps all segments, updates only R4
```

##### Navigate to Different Blog Post

```typescript
// Client currently has: L0,L1,R2,L3,R4
// User navigates to /blog/456

GET /blog/456?_has=L0,L1,R2,L3,R4

Server computation:
- Target route needs: L0,L1,R2 only
- Client has extra segments: L3,R4
- R2 needs update (different blog ID)

Response: {
  segments: ['L0', 'L1', 'R2'],  // Shorter list - no L3,R4
  updates: { R2: <BlogPost id="456" /> }
}
Client: Reconciles - sees L3,R4 not in list, removes them, updates R2
```

##### Structure Addition

```typescript
// Client on /blog/123 has: L0,L1,R2
// Navigates to /blog/123/author/456 (deeper)

GET /blog/123/author/456?_has=L0,L1,R2

Server computation:
- Target needs: L0,L1,R2,L3,R4
- Client missing: L3,R4

Response: {
  segments: ['L0', 'L1', 'R2', 'L3', 'R4'],  // Extended list
  updates: {
    L3: <AuthorLayout />,
    R4: <AuthorProfile id="456" />
  }
}
Client: Reconciles - sees L3,R4 in list but not rendered, adds them
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
  },
});

return new Response(stream, {
  headers: { "Content-Type": "application/x-rsc-stream" },
});
```

### Critical Implementation Notes

1. **Middleware Execution**: Middleware MUST run on EVERY request, regardless of partial/full render - this is critical for security
2. **Client-Server Protocol**: Client uses `_has` parameter to report current segments, server computes what to send - client never knows routing logic
3. **Outlet Component**: All layouts use simple `<Outlet />` syntax - implementation handles segment access internally (context on server, store lookup on client)
4. **Consistency**: Segment IDs (L0, R1, etc.) MUST remain consistent across renders for the same route structure
5. **State Preservation**: Persisted layouts must maintain their state when not re-rendered
6. **Error Isolation**: Errors in one segment must not affect others - use boundaries per segment
7. **Progressive Enhancement**: Full render fallback if client state is missing or corrupted
8. **Type Safety**: TypeScript must enforce valid segment references and context types
9. **Security First**: Never bypass middleware for performance - security checks are non-negotiable

This partial rendering system with client state reporting is **MANDATORY** for the router implementation. The architecture ensures:

- Minimal client complexity (client just reports what it has)
- Server controls all routing decisions
- Optimal performance through differential updates
- Security through mandatory middleware execution

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
  index: "/", // Will become /blog when mounted at /blog
  show: "/:slug", // Will become /blog/:slug when mounted at /blog
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
    // Layouts can be a single component or array of nested layouts
    [route.layout]: <MainLayout />, // Single layout
    // OR array for multiple nested layouts (applied in order)
    // [route.layout]: [<BaseLayout />, <MainLayout />],

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
  // Layout can be single component or array for nested layouts
  [route.layout]: BlogLayout,
  // OR multiple layouts that nest (outer to inner order)
  // [route.layout]: [AppShell, BlogLayout, BlogSidebar],

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
  index: "/", // Will become /admin
  users: "/users", // Will become /admin/users
  posts: "/posts", // Will become /admin/posts
  settings: "/settings", // Will become /admin/settings
});

let apiV1Routes = route({
  users: "/users", // Will become /api/v1/users
  posts: "/posts", // Will become /api/v1/posts
});

let apiV2Routes = route({
  users: "/users", // Will become /api/v2/users
  posts: "/posts", // Will become /api/v2/posts
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
  getRouter().current.revalidate();
  throw redirect(`/products/${productId}`);
  // or
  return redirect(`/products/${productId}`);
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

### Domain Router

```typescript
const domainRouter = createHostRouter({});
const websiteDomainRoute = hostRoute(["*"]);
const storeDomainRoute = hostRoute("*/store/*");
const docsDomainRoute = hostRoute("*/docs/*");
const authDomainRoute = hostRoute("*/auth/*");
const adminDomainRoute = hostRoute("admin.*");
const apiDomainRoute = hostRoute("api.*");

/* website */
domainRouter.host(websiteDomainRoute).map(() => import("app.server"));
/* store */
domainRouter.host(storeDomainRoute).map(() => import("store.server"));
/* docs */
domainRouter.host(docsDomainRoute).map(() => import("docs.server"));
/* auth */
domainRouter.host(authDomainRoute).map(() => import("auth.server"));
/* admin */
domainRouter.host(adminDomainRoute).map(() => import("admin.server"));
/* api */
domainRouter.host(apiDomainRoute).map(() => import("api.server"));
/* saas */
domainRouter
  .host(["*.*"])
  .use(saasMiddleware())
  .map(() => import("saas.server"));

export default domainRouter;
```

---

## RSC Framework Integration (Out-of-the-Box)

The router provides **production-ready framework integration** with `@vitejs/plugin-rsc` out-of-the-box. Users get complete RSC support with SPA navigation, partial rendering, and segment management with minimal setup.

### Architecture Overview

The framework consists of three entry points that handle different aspects of RSC rendering:

1. **entry.rsc.tsx** - Server-side RSC stream generation (react-server condition)
2. **entry.browser.tsx** - Client-side hydration and SPA navigation
3. **entry.ssr.tsx** - SSR HTML generation with payload injection

These work together with Vite's environment system to provide a complete RSC application.

### Zero-Config Setup

Users import pre-built framework files - no custom code needed:

```typescript
// vite.config.ts
import rsc from '@vitejs/plugin-rsc';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [rsc(), react()],
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.rsc.tsx' }
        }
      }
    },
    ssr: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.ssr.tsx' }
        }
      }
    },
    client: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.browser.tsx' }
        }
      }
    }
  }
});
```

```typescript
// src/entry.rsc.tsx (3 lines!)
import { createRSCHandler } from 'rsc-router/framework';
import router from './router'; // Your configured router
export default createRSCHandler(router);

// src/entry.browser.tsx (1 line!)
import 'rsc-router/framework/entry.browser';

// src/entry.ssr.tsx (1 line!)
export { renderHTML } from 'rsc-router/framework/entry.ssr';
```

**That's it!** You now have:
- ✅ Full RSC support with streaming
- ✅ SPA navigation (links don't reload page)
- ✅ Partial rendering (only changed segments sent)
- ✅ Automatic segment management
- ✅ Browser history integration
- ✅ Server action support
- ✅ HMR support

### router.matchPartial() - Differential Routing

The router provides `matchPartial()` for computing differential segments during navigation:

```typescript
interface PartialMatchResult {
  /**
   * Changed segments (from startIndex onwards)
   */
  segments: Segment[];

  /**
   * Index where segments diverge
   */
  startIndex: number;

  /**
   * Paths of preserved layouts
   */
  preservedLayouts: string[];
}

class RSCRouter {
  /**
   * Match a request for partial rendering
   *
   * Computes differential segments between previous and current routes.
   * Used for RSC partial rendering to send only changed segments.
   */
  async matchPartial(
    request: Request,
    previousPathname: string
  ): Promise<PartialMatchResult | null>;
}
```

**Usage in RSC entry:**

```typescript
// entry.rsc.tsx
const isPartialRequest = url.searchParams.has('_rsc_partial');
const previousPathname = url.searchParams.get('_rsc_prev');

if (isPartialRequest && previousPathname) {
  // Compute differential segments
  const partial = await router.matchPartial(request, previousPathname);

  if (partial) {
    // Send only changed segments
    // Client already has segments 0 to startIndex-1
    return {
      segments: partial.segments,        // Only changed
      startIndex: partial.startIndex,    // Where they diverge
      preservedLayouts: partial.preservedLayouts
    };
  }
}

// Fallback to full render
const match = await router.match(request);
```

**Example: Navigate from /blog to /blog/post-123**

```typescript
// Previous route: /blog
// Current route: /blog/post-123

const result = await router.matchPartial(request, '/blog');

// Result:
// {
//   segments: [R2],           // Only the post segment
//   startIndex: 2,            // L0, L1 preserved
//   preservedLayouts: ['/blog']
// }

// Client keeps: L0 (root), L1 (blog layout)
// Client updates: R2 (blog post)
// Bandwidth: ~2KB vs ~100KB full page
```

### Framework Entry Points Architecture

#### entry.rsc.tsx - Server RSC Stream Generation

**Responsibilities:**
- RSC stream serialization (React VDOM → RSC stream)
- Server function handling
- Full vs partial rendering logic
- Segment metadata generation

**Key Functions:**

```typescript
export function createRSCHandler(router: RSCRouter) {
  return async (request: Request): Promise<Response> => {
    // 1. Handle server actions (POST requests)
    if (request.method === 'POST') {
      // Execute server action
      // Update state
    }

    // 2. Determine render type
    const isPartial = url.searchParams.has('_rsc_partial');
    const previousPath = url.searchParams.get('_rsc_prev');

    // 3. Partial rendering
    if (isPartial && previousPath) {
      const partial = await router.matchPartial(request, previousPath);
      if (partial) {
        // Render only changed segments
        const component = renderSegments(partial.segments);
        return createRSCStream({
          root: component,
          metadata: {
            segments: partial.segments,
            startIndex: partial.startIndex,
            preservedLayouts: partial.preservedLayouts,
            isPartial: true
          }
        });
      }
    }

    // 4. Full rendering
    const match = await router.match(request);
    const segments = buildSegmentMap(match);
    const component = renderSegments(segments);

    // 5. Return RSC stream or delegate to SSR
    const rscStream = renderToReadableStream({ root: component, metadata });

    if (wantsRSC) {
      return new Response(rscStream);
    }

    // Delegate to SSR for HTML
    return ssrEntry.renderHTML(rscStream);
  };
}
```

**Parameters:**
- `_rsc_partial=true` - Request partial rendering
- `_rsc_prev=/previous/path` - Previous pathname for differential

**Response:**
- RSC stream with segment metadata
- Only changed segments in partial mode
- Full segments in full mode

#### entry.browser.tsx - Client Hydration + SPA Navigation

**Responsibilities:**
- RSC stream deserialization (RSC stream → React VDOM)
- Client-side rendering and hydration
- SPA navigation with link interception
- Partial rendering with segment reconciliation
- Browser history management

**Key Features:**

```typescript
// 1. Initial hydration
const initialPayload = await createFromReadableStream(rscStream);
const store = new SegmentStore(initialPayload.metadata?.segments || []);

// 2. Reconstruct tree from segments
const tree = reconstructTreeFromSegments(store.getAll());
hydrateRoot(document, tree);

// 3. Link interception for SPA navigation
document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (shouldInterceptLink(link, event)) {
    event.preventDefault();
    history.pushState(null, '', link.href);
    // Triggers navigation
  }
});

// 4. Navigation with partial rendering
async function navigate(url: string) {
  const currentSegments = store.getIds().join(',');
  const currentPath = window.location.pathname;

  // Fetch with partial parameters
  const fetchUrl = `${url}?_rsc_partial=true&_rsc_prev=${currentPath}`;
  const payload = await createFromFetch(fetch(fetchUrl));

  // Process partial payload
  if (payload.metadata.isPartial) {
    // Remove segments from startIndex onwards
    // Add new segments from payload
    // Reconstruct tree from merged segments
  }

  // Render without page reload
  setPayload(payload);
}

// 5. Browser history integration
window.addEventListener('popstate', () => navigate(location.href));
```

**Link Interception Rules:**
- Same origin only
- Left-click only (not cmd/ctrl+click)
- Not target="_blank"
- Not download links
- Not external links

**SPA Navigation Flow:**
1. User clicks link
2. Event intercepted, preventDefault()
3. history.pushState() updates URL
4. Fetch with `_rsc_partial` parameter
5. Receive partial payload
6. Merge segments with existing store
7. Reconstruct React tree
8. Render (no page reload!)

#### entry.ssr.tsx - SSR HTML Generation

**Responsibilities:**
- RSC stream deserialization (in SSR context)
- Traditional SSR (React VDOM → HTML stream)
- RSC payload injection for hydration
- Bootstrap script injection

**Key Functions:**

```typescript
export async function renderHTML(
  rscStream: ReadableStream,
  options: { formState?, nonce?, debugNojs? }
): Promise<ReadableStream> {
  // 1. Tee RSC stream (one for SSR, one for injection)
  const [rscStream1, rscStream2] = rscStream.tee();

  // 2. Deserialize RSC → React VDOM
  function SsrRoot() {
    const payload = React.use(createFromReadableStream(rscStream1));
    return <FixSsrThenable>{payload.root}</FixSsrThenable>;
  }

  // 3. Render React → HTML stream
  const htmlStream = await renderToReadableStream(<SsrRoot />, {
    bootstrapScriptContent,
    formState,
    nonce
  });

  // 4. Inject RSC payload into HTML
  const responseStream = htmlStream.pipeThrough(
    injectRSCPayload(rscStream2, { nonce })
  );

  return responseStream;
}
```

**Flow:**
1. Receives RSC stream from entry.rsc
2. Tees stream (SSR + client hydration)
3. Deserializes RSC to React VDOM
4. Renders VDOM to HTML stream
5. Injects RSC payload as `<script>...FLIGHT_DATA...</script>`
6. Injects bootstrap script for client code
7. Returns HTML stream

**FixSsrThenable Component:**
- Workaround for React SSR bugs with `lazy` + `use`
- See: https://github.com/facebook/react/issues/33937

### Complete Request-Response Flow

#### Initial Page Load (Full Render)

```
Browser:
  → GET /blog

Server (entry.rsc.tsx):
  → router.match(request)
  → buildSegmentMap(match)
  → segments: [L0, L1, R2, P3, P4]
  → renderSegments(segments)
  → renderToReadableStream({ root, metadata: { segments }})
  → Delegate to entry.ssr.tsx

Server (entry.ssr.tsx):
  → createFromReadableStream(rscStream)
  → renderToReadableStream(<SsrRoot />)
  → injectRSCPayload(rscStream2)
  → HTML stream with injected FLIGHT_DATA

Browser (entry.browser.tsx):
  → createFromReadableStream(rscStream) from FLIGHT_DATA
  → store = new SegmentStore(payload.metadata.segments)
  → reconstructTreeFromSegments(store.getAll())
  → hydrateRoot(document, tree)
  ✓ Page rendered and hydrated
```

#### SPA Navigation (Partial Render)

```
Browser:
  User clicks: <a href="/blog/post-123">
  → event.preventDefault()
  → history.pushState(null, '', '/blog/post-123')

Browser (entry.browser.tsx):
  → Current: /blog, has segments: [L0, L1, R2, P3, P4]
  → Fetch: /blog/post-123?_rsc_partial=true&_rsc_prev=/blog
  → createFromFetch(fetch(url))

Server (entry.rsc.tsx):
  → Detects _rsc_partial=true
  → router.matchPartial(request, '/blog')
  → Computes differential:
     - L0: layout, preserved ✅
     - L1: layout, preserved ✅
     - R2: route, changed (different slug) ⚠️
     - P3: parallel, changed (new params) ⚠️
     - P4: parallel, changed (new params) ⚠️
  → startIndex: 2 (L0, L1 preserved)
  → segments: [R2, P3, P4] (only changed)
  → renderSegments([R2, P3, P4])
  → Return RSC stream with metadata

Browser (entry.browser.tsx):
  → Receives partial payload
  → metadata.isPartial: true
  → metadata.startIndex: 2
  → Remove segments from index 2 onwards
  → Add new segments: R2, P3, P4
  → reconstructTreeFromSegments([L0, L1, R2, P3, P4])
  → setPayload(newPayload)
  ✓ UI updates without page reload!
  ✓ Bandwidth: ~2KB vs ~100KB full page
```

### Segment Metadata in RscPayload

The framework uses this payload structure for client-server communication:

```typescript
type RscPayload = {
  // The React tree to render
  root: React.ReactNode;

  // Server action results
  returnValue?: unknown;
  formState?: ReactFormState;

  // Segment metadata for partial rendering
  metadata?: {
    pathname: string;
    segments: Segment[];          // Full list of segments
    startIndex?: number;          // Where segments diverge
    preservedLayouts?: string[];  // Layout paths preserved
    isPartial?: boolean;          // Is this a partial response
  };
};

type Segment = {
  id: string;              // 'L0', 'R1', 'P2'
  type: 'layout' | 'route' | 'parallel';
  index: number;           // Sequential index
  component: React.ReactNode;
  slot?: string;           // For parallel routes (@sidebar)
  path?: string;
  params?: Record<string, string>;
};
```

### Client-Side Segment Management

The browser automatically manages segments using `SegmentStore`:

```typescript
// entry.browser.tsx implementation

// Initialize store from SSR
const store = new SegmentStore(initialPayload.metadata?.segments || []);

// On navigation with partial payload
if (payload.metadata.isPartial) {
  const startIdx = payload.metadata.startIndex ?? 0;

  // Remove old segments from divergence point
  store.getAll().forEach(seg => {
    if (seg.index >= startIdx) {
      store.removeSegment(seg.id);
    }
  });

  // Add new segments
  payload.metadata.segments.forEach(seg => {
    store.addSegment(seg);
  });

  // Reconstruct tree
  const tree = reconstructTreeFromSegments(store.getAll());
  setRoot(tree);
}
```

**Segment Merging Example:**

```
Before navigation (/blog):
  Store: [L0, L1, R2, P3, P4]

Partial response (/blog/new-post):
  metadata.startIndex: 2
  metadata.segments: [R2', P3', P4']

After merging:
  Store: [L0, L1, R2', P3', P4']
  (L0, L1 kept, R2, P3, P4 replaced)

Tree: <L0><L1><><R2'/><P3'/><P4'/></></L1></L0>
```

### Link Interception for SPA Navigation

The framework automatically intercepts links for SPA navigation:

```typescript
// entry.browser.tsx implementation

function shouldInterceptLink(link: HTMLAnchorElement, event: MouseEvent): boolean {
  return (
    link.origin === location.origin &&  // Same origin
    !link.target &&                     // No target
    !link.hasAttribute('download') &&   // Not download
    event.button === 0 &&               // Left click
    !event.metaKey &&                   // Not cmd+click
    !event.ctrlKey &&                   // Not ctrl+click
    !event.defaultPrevented             // Not prevented
  );
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (shouldInterceptLink(link, event)) {
    event.preventDefault();
    history.pushState(null, '', link.href);
    // Navigation triggers automatically
  }
});
```

**What gets intercepted:**
- ✅ `<a href="/blog">Blog</a>` - Same origin, normal click
- ✅ `<a href="/about">About</a>` - Any internal link
- ❌ `<a href="https://external.com">External</a>` - Different origin
- ❌ `<a href="/file.pdf" download>Download</a>` - Download attribute
- ❌ `<a href="/page" target="_blank">New Tab</a>` - Target specified
- ❌ Cmd+Click or Ctrl+Click - Open in new tab

### Partial Rendering Request Flow

#### Client Request Headers

```http
GET /blog/post-123?_rsc_partial=true&_rsc_prev=/blog HTTP/1.1
Accept: text/x-component
```

#### Server Response (Partial)

```typescript
// entry.rsc.tsx computes differential
{
  root: <Fragment><BlogPost /><Sidebar /><Comments /></Fragment>,
  metadata: {
    pathname: '/blog/post-123',
    segments: [R2, P3, P4],     // Only changed segments
    startIndex: 2,              // L0, L1 preserved
    preservedLayouts: ['/blog'],
    isPartial: true
  }
}
```

#### Client Processing

```typescript
// entry.browser.tsx receives and processes
console.log('Partial payload received');
console.log('Start index:', 2);          // L0, L1 preserved
console.log('New segments:', ['R2', 'P3', 'P4']);

// Merge with existing
store.removeSegment('R2');  // Remove old
store.removeSegment('P3');
store.removeSegment('P4');

store.addSegment(newR2);    // Add new
store.addSegment(newP3);
store.addSegment(newP4);

// Reconstruct: [L0, L1, R2', P3', P4']
const tree = reconstructTreeFromSegments(store.getAll());

// Render (no page reload!)
setPayload({ root: tree });
```

### Browser History Integration

The framework automatically handles browser navigation:

```typescript
// entry.browser.tsx

// Forward navigation
history.pushState(null, '', '/new-path');
// → Triggers navigation with partial rendering

// Back button
window.addEventListener('popstate', () => {
  navigate(location.href);
  // → Fetches and renders previous state
});

// Replace (e.g., after form submission)
history.replaceState(null, '', '/success');
// → Updates URL and triggers navigation
```

### Development Features

#### Hot Module Replacement

```typescript
// entry.browser.tsx
if (import.meta.hot) {
  import.meta.hot.on('rsc:update', () => {
    // Re-fetch and update when server code changes
    fetchRscPayload(manager);
  });
}
```

#### Debug Modes

```
?__rsc    - Force RSC stream response (see raw payload)
?__html   - Force HTML response (see SSR output)
?__nojs   - Disable JavaScript (test progressive enhancement)
```

### Integration with Router Features

#### Middleware Execution

Middleware **ALWAYS executes** even for partial renders:

```typescript
// entry.rsc.tsx
const match = await router.match(request);
// ↑ This executes all middleware

const partial = await router.matchPartial(request, prev);
// ↑ This also executes all middleware

// Security: Cannot bypass middleware with partial rendering
```

#### Parallel Routes

Parallel routes render alongside main content:

```typescript
// Router config
{
  index: () => <Main />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@modal': () => <Modal />
  }
}

// entry.rsc.tsx renders
const segments = buildSegmentMap(match);
// [R0: Main, P1: Sidebar, P2: Modal]

const tree = renderSegments(segments);
// <><Main /><Sidebar /><Modal /></>

// All three render together (ADDITIVE)
```

#### Layout Nesting

Layouts automatically nest with OutletProvider:

```typescript
// Router config
{
  [route.layout]: [RootLayout, BlogLayout, BlogSidebar],
  show: () => <BlogPost />
}

// entry.rsc.tsx renders
const segments = buildSegmentMap(match);
// [L0: RootLayout, L1: BlogLayout, L2: BlogSidebar, R3: BlogPost]

const tree = renderSegments(segments);
// <OutletProvider content={...}>
//   <RootLayout />
// </OutletProvider>
// (nested via OutletProvider)

// entry.browser.tsx reconstructs same tree
const tree = reconstructTreeFromSegments(store.getAll());
```

### Performance Optimizations

#### Bandwidth Savings

```
Full page reload:
  - HTML: ~50KB
  - JavaScript: ~200KB
  - CSS: ~30KB
  - Images: ~100KB
  Total: ~380KB

Partial render (only R2 segment):
  - RSC payload: ~2KB
  - Savings: ~99.5%
```

#### Segment Reuse

```
Navigate /blog/post-1 → /blog/post-2:
  - L0 (RootLayout): Reused ✅
  - L1 (BlogLayout): Reused ✅
  - R2 (BlogPost): Updated ⚠️
  - P3 (Sidebar): Reused ✅
  - P4 (Comments): Reused ✅

Result: 80% segments reused
```

### Error Handling

#### Server Errors

```typescript
// entry.rsc.tsx
try {
  const match = await router.match(request);
  // ...
} catch (error) {
  return { root: <ErrorPage error={error} /> };
}
```

#### Client Errors

```typescript
// entry.browser.tsx
try {
  const payload = await createFromFetch(fetch(url));
  // ...
} catch (error) {
  console.error('Navigation failed:', error);
  // Show error UI
}
```

#### 404 Handling

```typescript
// entry.rsc.tsx
if (!match) {
  return {
    root: (
      <html>
        <body>
          <h1>404 - Not Found</h1>
        </body>
      </html>
    )
  };
}
```

---

## Framework Implementation Summary

The RSC Router framework provides:

1. **router.matchPartial()** - Differential routing for partial rendering
2. **entry.rsc.tsx** - Server RSC stream generation with partial support
3. **entry.browser.tsx** - Client SPA navigation with automatic link interception
4. **entry.ssr.tsx** - SSR HTML generation with payload injection
5. **Zero-config setup** - Import and use, no custom code
6. **Production-ready** - Used in production with vite-plugin-rsc

**Total framework code**: ~780 lines
**User setup code**: ~5 lines
**Features**: Full RSC + SPA + Partial Rendering

This makes RSC Router a **complete, production-ready solution** for React Server Components with Vite.
