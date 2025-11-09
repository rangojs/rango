# Basic RSC Router Example

This example demonstrates the core features of the RSC Router with partial rendering support.

## Quick Start

```bash
# Install dependencies
npm install

# Run in browser (interactive demo with Vite)
npm run dev
# Then open: http://localhost:3001

# Build for production
npm run build

# CLI Demos (console output)
npm run demo:cli         # Main demo (6 scenarios)
npm run demo:parallel    # Parallel routes examples
npm run demo:request     # Request handler flow
```

## Two Ways to Run

### 1. Browser Demo (Vite)

Run `npm run dev` and open http://localhost:3001

Interactive UI showing:
- Click buttons to navigate
- Real-time log of navigation events
- Visual display of segments (complete list vs updates)
- Bandwidth savings metrics
- Clean browser-based demonstration

### 2. CLI Demos (Console)

Run `npm run demo:cli` for console output

The demo simulates 6 different navigation scenarios showing:
- Initial page loads (full render)
- Subsequent navigation (partial updates)
- Structure changes (adding/removing segments)
- Parallel routes (additive rendering)
- Bandwidth savings (80-99% reduction)

Each scenario shows:
- Request details
- Client state (_has parameter)
- Server response (segments + updates)
- Efficiency metrics
- Which segments were kept vs updated

## Features Demonstrated

- ✅ **Route Definitions** - Type-safe route maps with nested routes
- ✅ **Layouts** - Single and array layouts with nesting
- ✅ **Parallel Routes** - @sidebar and @modal slots rendering alongside main content
- ✅ **Partial Rendering** - Client-server differential updates
- ✅ **Navigation** - SPA navigation with _has parameter
- ✅ **Middleware** - Global and route-specific middleware

## File Structure

```
examples/basic/
├── README.md           # This file
├── routes.ts           # Route definitions
├── server.ts           # Server-side router setup
├── client.ts           # Client-side navigation
├── handlers/
│   ├── home.tsx        # Home page handlers
│   ├── blog.tsx        # Blog handlers with parallel routes
│   └── dashboard.tsx   # Dashboard with layouts
└── components/
    ├── layouts/        # Layout components
    ├── routes/         # Route components
    └── parallel/       # Parallel route components
```

## Quick Start

### 1. Define Routes

```typescript
// routes.ts
import { route } from 'rsc-router';

export const mainRoutes = route({
  home: '/',
  about: '/about'
});

export const blogRoutes = route({
  index: '/',
  show: '/:slug',
  category: '/:category/:slug'
});

export const dashboardRoutes = route({
  index: '/',
  analytics: '/analytics',
  settings: '/settings'
});
```

### 2. Set Up Server

```typescript
// server.ts
import { createRSCRouter } from 'rsc-router';
import { mainRoutes, blogRoutes, dashboardRoutes } from './routes';
import * as blogHandlers from './handlers/blog';

const router = createRSCRouter();

// Global middleware
router
  .use(async (ctx, next) => {
    console.log(`→ ${ctx.pathname}`);
    await next();
  })
  .use(authMiddleware());

// Main routes
router
  .route(mainRoutes)
  .map({
    [route.layout]: RootLayout,
    home: () => <HomePage />,
    about: () => <AboutPage />
  });

// Blog routes with parallel routes
router
  .route('/blog', blogRoutes)
  .use(blogMiddleware())
  .map({
    [route.layout]: [RootLayout, BlogLayout],
    [route.parallel]: {
      '@sidebar': () => <BlogSidebar />,
      '@comments': () => <CommentSection />
    },
    index: () => <BlogIndex />,
    show: (ctx) => <BlogPost slug={ctx.params.slug} />
  });

// Dashboard with per-route parallel routes
router
  .route('/dashboard', dashboardRoutes)
  .use(requireAuth())
  .map({
    [route.layout]: [RootLayout, DashboardLayout],
    index: {
      [route.parallel]: {
        '@sidebar': () => <DashboardSidebar />,
        '@notifications': () => <NotificationPanel />
      },
      handler: () => <DashboardMain />
    },
    analytics: () => <AnalyticsPage />,
    settings: () => <SettingsPage />
  });

export default router;
```

### 3. Handle Requests

```typescript
// Server request handler
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // 1. Match route
  const match = await router.match(request);
  if (!match) {
    return new Response('Not Found', { status: 404 });
  }

  // 2. Build segment map
  const targetSegments = buildSegmentMap({
    pathname: match.pathname,
    params: match.params,
    handlers: match.handlers
  });

  // 3. Parse client state
  const hasParam = url.searchParams.get('_has');
  const clientHas = parseClientSegments(hasParam);

  // 4. Create RSC payload (differential)
  const payload = createRSCPayload(targetSegments, clientHas);

  // 5. Return as JSON (or RSC stream in production)
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 4. Client-Side Navigation

```typescript
// client.ts
import { SegmentStore, navigateToRoute, processPayload, reconstructTreeFromSegments } from 'rsc-router/client';

// Initialize store (hydrate from SSR)
const store = new SegmentStore(window.__INITIAL_SEGMENTS__);

// Navigation function
async function navigate(pathname: string) {
  try {
    // 1. Fetch with _has parameter
    const payload = await navigateToRoute(pathname, { store });

    // 2. Process payload (reconcile + update store)
    processPayload(payload, store);

    // 3. Reconstruct React tree
    const tree = reconstructTreeFromSegments(store.getAll());

    // 4. Render
    root.render(tree);

    // 5. Update browser URL
    window.history.pushState({}, '', pathname);
  } catch (error) {
    console.error('Navigation failed:', error);
  }
}

// Use in your app
navigate('/blog/hello-world');
```

## How Partial Rendering Works

### Initial Page Load

```
Client: (empty)
Server: Renders full page
Response: {
  segments: ['L0', 'L1', 'R2', 'P3', 'P4'],
  updates: {
    'L0': <RootLayout />,
    'L1': <BlogLayout />,
    'R2': <BlogPost />,
    'P3': <Sidebar />,
    'P4': <Comments />
  }
}
Client: Stores all 5 segments
```

### Navigation to Different Post

```
Client: Has ['L0', 'L1', 'R2', 'P3', 'P4']
Request: GET /blog/new-post?_has=L0,L1,R2,P3,P4
Server: Computes differential
  - L0 (RootLayout): unchanged ✅
  - L1 (BlogLayout): unchanged ✅
  - R2 (BlogPost): changed (new slug) ⚠️
  - P3 (Sidebar): unchanged ✅
  - P4 (Comments): unchanged ✅
Response: {
  segments: ['L0', 'L1', 'R2', 'P3', 'P4'],
  updates: {
    'R2': <BlogPost slug="new-post" />  // Only R2!
  }
}
Client: Updates only R2, keeps others
Bandwidth: ~2KB vs ~100KB full page
```

### Navigation to Different Section

```
Client: Has ['L0', 'L1', 'R2', 'P3', 'P4']
Request: GET /dashboard?_has=L0,L1,R2,P3,P4
Server: Computes differential
  - L0 (RootLayout): reused ✅
  - L1 (BlogLayout): removed ❌
  - R2 (BlogPost): removed ❌
  - P3 (Sidebar): removed ❌
  - P4 (Comments): removed ❌
  - L5 (DashboardLayout): new ⚠️
  - R6 (Dashboard): new ⚠️
  - P7 (@sidebar): new ⚠️
  - P8 (@notifications): new ⚠️
Response: {
  segments: ['L0', 'L5', 'R6', 'P7', 'P8'],
  updates: {
    'L5': <DashboardLayout />,
    'R6': <Dashboard />,
    'P7': <DashboardSidebar />,
    'P8': <NotificationPanel />
  }
}
Client: Reconciles - removes L1,R2,P3,P4, adds L5,R6,P7,P8
```

## Parallel Routes: Additive Rendering

**IMPORTANT**: Parallel routes render **alongside** main content, not replacing it.

```typescript
// Handlers
{
  index: () => <MainContent />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@modal': () => <Modal />
  }
}

// Renders as:
<>
  <MainContent />    {/* Main route */}
  <Sidebar />        {/* @sidebar parallel */}
  <Modal />          {/* @modal parallel */}
</>
```

## Components

See `components/` folder for example implementations of:
- Layouts with `<Outlet />` for nesting
- Route components with params
- Parallel route components (@sidebar, @modal)

## Learn More

- [API Documentation](../../README.md)
- [Implementation Changesets](../../.implementation-changesets/)
- [Design Doc](../../../apps/web/src/Router%20API%20Ideas.md)
