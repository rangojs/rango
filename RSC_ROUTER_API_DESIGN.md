# RSC Router API Design

## Route Definition API

### Basic Routes

```typescript
import { route } from "rsc-router";

// Define route map with patterns
export const blogRoutes = route({
  index: "/blog",
  post: "/blog/:slug",
  category: "/blog/:category/:id",
});
```

### Nested Routes (Relative Paths)

```typescript
// Routes defined relative to mount point (no /admin prefix)
export const adminRoutes = route({
  dashboard: "/", // Becomes /admin when mounted at /admin
  users: {
    list: "/users", // Becomes /admin/users
    detail: "/users/:id", // Becomes /admin/users/:id
    edit: "/users/:id/edit", // Becomes /admin/users/:id/edit
  },
  settings: "/settings", // Becomes /admin/settings
});

// Mount at /admin - routes are automatically prefixed
router.route("/admin", adminRoutes);

// Routes are reusable - can be mounted elsewhere
router.route("/dashboard", adminRoutes); // /dashboard/users, /dashboard/settings, etc.
```

## Handler Definition API

### Type-Safe Handlers (Separate File)

```typescript
// handlers/blog.handlers.tsx
import { map } from 'rsc-router';
import type { blogRoutes } from '../routes/blog.routes';

export default map<typeof blogRoutes>({
  // Single layout
  [route.layout]: BlogLayout,

  // Route handlers with typed params
  index: (ctx) => <BlogIndex />,

  post: (ctx) => {
    // ctx.params.slug is typed as string
    // ctx.params.foo would be TypeScript error
    return <BlogPost slug={ctx.params.slug} />;
  },

  category: (ctx) => {
    // ctx.params = { category: string, id: string }
    return <Category category={ctx.params.category} id={ctx.params.id} />;
  }
});
```

### Nested Layouts

```typescript
export default map<typeof routes>({
  // Multiple layouts (outer to inner)
  [route.layout]: [RootLayout, AppShell, BlogLayout],

  index: (ctx) => <Home />,
  post: (ctx) => <Post slug={ctx.params.slug} />
});
```

### Revalidation (Future)

```typescript
export default map<typeof blogRoutes>({
  [route.layout]: BlogLayout,

  post: (ctx) => <BlogPost slug={ctx.params.slug} />,

  // Revalidation function for params changes
  [route.revalidate]: {
    post: ({ prevParams, nextParams, prevUrl, nextUrl, context }) => {
      // Force re-render if slug changed
      return prevParams.slug !== nextParams.slug;
    }
  }
});
```

## Router Creation API

### Generic Context Type

```typescript
import { createRSCRouter } from "rsc-router";

// Define app-specific context
interface AppContext {
  db: Database;
  user?: User;
  env: Env;
  session: Session;
}

// Create typed router
const router = createRSCRouter<AppContext>();
```

### Route Registration

```typescript
import { blogRoutes } from "./routes/blog.routes";
import { shopRoutes } from "./routes/shop.routes";

router
  .route("/blog", blogRoutes) // Registration ID: 0
  .map(() => import("./handlers/blog.handlers"))

  .route("/shop", shopRoutes) // Registration ID: 1
  .map(() => import("./handlers/shop.handlers"));
```

### Inline Handlers (Eager)

```typescript
router
  .route('/about', aboutRoutes)
  .map({
    [route.layout]: RootLayout,
    index: () => <AboutPage />
  });
```

## Handler Context API

### Context Shape

```typescript
type HandlerContext<TParams, TAppContext> = {
  params: TParams; // Extracted from route pattern
  request: Request; // Original request
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
} & TAppContext; // App-specific context
```

### Usage in Handlers

```typescript
export default map<typeof blogRoutes>({
  post: (ctx) => {
    // From route pattern
    ctx.params.slug  // string

    // From Request
    ctx.request      // Request
    ctx.pathname     // string
    ctx.url          // URL
    ctx.searchParams // URLSearchParams

    // From AppContext
    ctx.db           // Database
    ctx.user         // User | undefined
    ctx.env          // Env
    ctx.session      // Session

    return <BlogPost />;
  }
});
```

## Router Match API

### Full Render

```typescript
// entry.rsc.tsx
const result = await router.match(request, context);

// Result shape
result = {
  segments: ResolvedSegment[],  // Full segments with components
  matched: string[],             // All segment IDs: ['L0.0', 'L1.0', 'R2.0']
  diff: string[]                 // Same as matched for full render
}
```

### Partial Render

```typescript
// entry.rsc.tsx
// Router extracts previous URL from header
const result = await router.matchPartial(request, context);

// Internally:
// - Reads X-RSC-Router-Client-Path header for previous URL
// - Reads _rsc_segments query param for client segment IDs
// - Compares previous route vs current route
// - Returns only changed segments

// Result shape
result = {
  segments: ResolvedSegment[],  // Only changed segments with components
  matched: string[],             // All segment IDs for new route
  diff: string[]                 // Only rendered segment IDs
}
```

## Segment System

### Segment Structure

```typescript
interface ResolvedSegment {
  id: string; // 'L0.0', 'R2.1', etc.
  type: "layout" | "route";
  index: number; // Position in segment array
  component: ReactNode; // React component
  params?: Record<string, string>;
}
```

### Segment ID Format

```
{Type}{Position}.{RegistrationId}

L0.0  = Layout position 0, registration 0
L1.0  = Layout position 1, registration 0
R2.0  = Route position 2, registration 0
L0.1  = Layout position 0, registration 1
```

### Globally Unique IDs

**Key Decision**: Each `.route()` registration gets unique ID space.

```typescript
router
  .route("/blog", blogRoutes) // IDs: L0.0, L1.0, R2.0
  .map(blogHandlers)
  .route("/shop", shopRoutes) // IDs: L0.1, L1.1, R2.1
  .map(shopHandlers);

// Even if both use RootLayout, they have different IDs
// /blog: L0.0 (RootLayout)
// /shop: L0.1 (RootLayout)
```

## Outlet Component API

### Layout Usage

```typescript
function BlogLayout() {
  return (
    <div>
      <h1>Blog</h1>
      <nav>...</nav>
      <Outlet />  {/* Renders child content */}
    </div>
  );
}
```

### Future: useOutlet Hook

```typescript
function BlogLayout() {
  const outlet = useOutlet();  // ReactNode | null

  return (
    <div>
      <h1>Blog</h1>
      {outlet}  {/* Manual rendering */}
    </div>
  );
}

function BlogPost() {
  const outlet = useOutlet();  // null (leaf node)
  return <article>...</article>;
}
```

**Key Decision**: Every segment wrapped in OutletProvider, regardless of type.

## Partial Rendering Protocol

### Request Format

```typescript
// Full render (initial page load)
GET /blog/hello

// Partial render (navigation)
GET /blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0
Headers:
  X-RSC-Router-Client-Path: /blog/hello?queries=asd#even-hash

// Server action (form submission)
POST /blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0
Headers:
  X-RSC-Router-Client-Path: /blog/hello?queries=asd#even-hash
```

### Parameter Definitions

**Query Params:**

- `_rsc_partial=true` - Request partial update
- `_rsc_segments` - Comma-separated segment IDs client already has

**Headers:**

- `X-RSC-Router-Client-Path` - Full current browser URL including query params and hash

**Key Decision**: Previous URL in header (not query param) to avoid URL length limits and preserve full URL with queries/hash.

### Client Navigation Request

```typescript
// entry.browser.tsx
const currentUrl = window.location.href; // Full URL: /blog/hello?queries=asd#hash
const currentSegments = ["L0.0", "L1.0", "R2.0"];

const fetchUrl = new URL("/blog/world", window.location.origin);
fetchUrl.searchParams.set("_rsc_partial", "true");
fetchUrl.searchParams.set("_rsc_segments", currentSegments.join(","));

const payload = await fetch(fetchUrl, {
  headers: {
    "X-RSC-Router-Client-Path": currentUrl, // Full URL with queries & hash
  },
});
```

### Prefetching

```typescript
// Prefetch URL (query params only - no header needed for prefetch)
<link rel="prefetch"
      href="/blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0" />

// Note: Prefetch doesn't send headers, but that's OK - server can handle
// missing X-RSC-Router-Client-Path by skipping revalidation checks
```

**Key Decision**: Prefetch uses query params only. Server gracefully handles missing header.

## Response Payload API

### Full Render Payload

```typescript
{
  root: ReactNode,           // Full composed tree with OutletProvider wrapping
  metadata: {
    pathname: string,
    segments: SegmentMetadata[]  // Metadata only (no components)
  }
}

// segments metadata shape:
[
  { id: 'L0.0', type: 'layout', index: 0 },
  { id: 'L1.0', type: 'layout', index: 1 },
  { id: 'R2.0', type: 'route', index: 2, params: { slug: 'hello' } }
]
```

**Key Decision**: Duplication of structure (root + segments) accepted for MVP.

### Partial Render Payload

```typescript
{
  root: null,                // No tree - client builds it
  metadata: {
    pathname: string,
    segments: ResolvedSegment[],  // Full segments WITH components
    isPartial: true,
    matched: string[],        // All segment IDs: ['L0.0', 'L1.0', 'R2.0']
    diff: string[]            // Only rendered IDs: ['R2.0']
  }
}

// segments shape (WITH components):
[
  {
    id: 'R2.0',
    type: 'route',
    index: 2,
    component: <BlogPost />,
    params: { slug: 'world' }
  }
]
```

## Revalidation Logic

### Default Behavior

```typescript
// Navigate /blog/hello → /blog/world
// Both match same route registration, same segment IDs

// Client has: ['L0.0', 'L1.0', 'R2.0']
// Server matches: ['L0.0', 'L1.0', 'R2.0']

// For each segment:
// L0.0: Client has it, params unchanged → Skip
// L1.0: Client has it, params unchanged → Skip
// R2.0: Client has it, BUT params changed (hello→world) → Re-render

// Default: Re-render if params changed
```

### Custom Revalidation

```typescript
export default map<typeof blogRoutes>({
  post: (ctx) => <BlogPost slug={ctx.params.slug} />,

  [route.revalidate]: {
    post: ({ prevParams, nextParams, prevUrl, nextUrl, context }) => {
      // Custom logic - only revalidate if slug changed
      if (prevParams.slug !== nextParams.slug) {
        return true;
      }

      // Check other conditions
      if (context.user?.id !== prevContext.user?.id) {
        return true;
      }

      return false;
    }
  }
});
```

## Client-Side Reconstruction

### Full Render (Server Builds)

```typescript
// Server
const segments = await router.match(request, context);
const root = renderSegments(segments.segments); // Build tree
return { root, metadata };

// Client
hydrateRoot(document, payload.root); // Use pre-built tree
```

### Partial Render (Client Builds)

```typescript
// Server
const result = await router.matchPartial(request, context);
return { root: null, metadata: { segments: result.segments, ... } };

// Client
const { segments, matched, diff } = payload.metadata;

// Merge: Keep old segments, replace changed ones
const fullSegments = matched.map(id => {
  if (diff.includes(id)) {
    return segments.find(s => s.id === id);  // New from server
  } else {
    return currentSegments.find(s => s.id === id);  // Keep existing
  }
});

// Build tree on client
const root = renderSegments(fullSegments);
setPayload({ root, metadata: payload.metadata });
```

**Key Decision**: Server renders tree for full, client reconstructs for partial.

## Example: Complete Flow

### 1. Define Routes

```typescript
// routes/blog.routes.ts
export const blogRoutes = route({
  index: "/blog",
  post: "/blog/:slug",
});
```

### 2. Define Handlers

```typescript
// handlers/blog.handlers.tsx
export default map<typeof blogRoutes>({
  [route.layout]: [RootLayout, BlogLayout],
  index: (ctx) => <BlogIndex />,
  post: (ctx) => <BlogPost slug={ctx.params.slug} />
});
```

### 3. Register Routes

```typescript
// router.ts
const router = createRSCRouter<AppContext>();

router.route("/blog", blogRoutes).map(() => import("./handlers/blog.handlers"));
```

### 4. Match Requests

```typescript
// entry.rsc.tsx
export function createRSCHandler(router: RSCRouter) {
  return async (request: Request) => {
    const context: AppContext = {
      db: getDb(),
      user: await getUser(request),
      env: getEnv(),
      session: await getSession(request),
    };

    const url = new URL(request.url);
    const isPartial = url.searchParams.has("_rsc_partial");

    if (isPartial) {
      const result = await router.matchPartial(request, context);
      return {
        root: null,
        metadata: {
          pathname: url.pathname,
          segments: result.segments,
          isPartial: true,
          matched: result.matched,
          diff: result.diff,
        },
      };
    } else {
      const result = await router.match(request, context);
      const root = renderSegments(result.segments);
      return {
        root,
        metadata: {
          pathname: url.pathname,
          segments: result.segments.map((s) => ({
            id: s.id,
            type: s.type,
            index: s.index,
            params: s.params,
          })),
        },
      };
    }
  };
}
```

## Key Technical Decisions

1. **Generic Context Type**: `createRSCRouter<TAppContext>()` for type-safe context flow
2. **Separate Routes from Handlers**: Type-only imports, lazy handler execution
3. **Globally Unique Segment IDs**: `{Type}{Position}.{RegistrationId}` format
4. **Previous URL in Header**: `X-RSC-Router-Client-Path` header (not query param) to avoid URL length limits
5. **Segments in Query Param**: `_rsc_segments` query param for CDN caching and prefetching
6. **Client Tracks Segment IDs**: Explicit state vs pathname diffing
7. **Server Builds Full Tree**: Client builds partial tree from merged segments
8. **Universal OutletProvider Wrapping**: All segments wrapped regardless of type
9. **Prefetch Graceful Degradation**: Prefetch works without header, server skips revalidation checks
10. **Payload Duplication in Full Render**: root + segments metadata (optimize post-MVP)
11. **Params-Based Revalidation**: Default re-render when params change

## Future APIs (Post-MVP)

### Middleware

```typescript
export default map<typeof blogRoutes>({
  [route.middleware]: [blogAuth(), blogRateLimit()],
  [route.layout]: BlogLayout,
  post: (ctx) => <BlogPost />
});
```

### Parallel Routes

```typescript
export default map<typeof routes>({
  [route.layout]: DashboardLayout,
  [route.parallel]: {
    '@sidebar': Sidebar,
    '@modal': Modal
  },
  dashboard: (ctx) => <Dashboard />
});
```

### Loading & Error Boundaries

```typescript
export default map<typeof routes>({
  [route.loading]: Loading,
  [route.error]: ErrorBoundary,
  post: (ctx) => <BlogPost />
});
```
