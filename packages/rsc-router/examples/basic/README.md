# Basic RSC Router Example

**Production-ready example** using RSC Router's out-of-the-box framework integration with `@vitejs/plugin-rsc`.

This demonstrates:
- ✅ Real RSC streaming with vite-plugin-rsc
- ✅ Three-entry architecture (rsc, browser, ssr)
- ✅ SPA navigation with automatic link interception
- ✅ Partial rendering with segment management
- ✅ Zero custom framework code (uses router framework)

## Quick Start

```bash
# Install dependencies
npm install

# Run CLI demos (working demonstrations)
npm run demo:cli         # 6 scenarios showing partial rendering
npm run demo:parallel    # Parallel routes examples
npm run demo:request     # Request handler flow

# Full RSC setup (requires monorepo context)
# For a working RSC app, see: ../../apps/web
# This example provides the template entry points
```

## Important Note

This directory serves two purposes:

### 1. **Working CLI Demos** ✅

The CLI demos (`npm run demo:cli`, `demo:parallel`, `demo:request`) are **fully functional** and demonstrate:
- Partial rendering with differential updates
- Segment management
- Parallel routes (additive behavior)
- Request-response flows
- Bandwidth savings

**These work out-of-the-box** - just `npm install` and run!

### 2. **Production Entry Point Templates** 📝

The entry files (`entry.rsc.tsx`, `entry.browser.tsx`, `entry.ssr.tsx`) are **production-ready templates** showing the exact code users need. These are templates to copy to your own project.

### 3. **Fully Working RSC App** 🔗

**For a complete, running RSC application** using the router framework, see:

👉 **`/apps/web`** in the monorepo root

This has:
- Complete vite-plugin-rsc setup
- All peer dependencies configured
- Real RSC streaming
- SPA navigation working
- Full framework integration

The `apps/web` application demonstrates the router in production use with the actual framework entry points.

## What's Included

### 1. **Production Entry Point Templates**

This example includes **production-ready entry points** showing exactly what users need:

- **entry.rsc.tsx** (3 lines!) - Uses `createRSCHandler(router)`
- **entry.browser.tsx** (1 line!) - Imports framework browser entry
- **entry.ssr.tsx** (1 line!) - Re-exports framework SSR renderer

These are **templates** you can copy to your own project. For a **fully working** setup, see `apps/web` in the monorepo.

### 2. **Working CLI Demos** (No vite-plugin-rsc required)

Standalone demos showing concepts:

- `npm run demo:cli` - 6 navigation scenarios with metrics
- `npm run demo:parallel` - Parallel routes additive behavior
- `npm run demo:request` - Request handling flow

These run without vite-plugin-rsc to demonstrate the router API.

## Features Demonstrated

- ✅ **Route Definitions** - Type-safe route maps with nested routes
- ✅ **Layouts** - Single and array layouts with nesting
- ✅ **Parallel Routes** - @sidebar and @modal slots rendering alongside main content
- ✅ **Partial Rendering** - Client-server differential updates
- ✅ **Navigation** - SPA navigation with _has parameter
- ✅ **Middleware** - Global and route-specific middleware

## Architecture

This example uses the **production framework** from `rsc-router/framework`:

```
examples/basic/
├── package.json         # vite-plugin-rsc + rsc-html-stream
├── vite.config.ts       # Three environments (rsc, ssr, client)
├── entry.rsc.tsx        # Server entry (3 lines - uses framework)
├── entry.browser.tsx    # Client entry (1 line - uses framework)
├── entry.ssr.tsx        # SSR entry (1 line - uses framework)
├── routes.ts            # Route definitions
├── server.tsx           # Router configuration
└── [demos]              # CLI learning tools
    ├── index.tsx
    ├── parallel-routes-demo.tsx
    └── request-handler.tsx
```

### Framework Entry Points

**entry.rsc.tsx** - Just 3 lines!
```typescript
import { createRSCHandler } from 'rsc-router/framework';
import router from './server';
export default createRSCHandler(router);
```

**entry.browser.tsx** - Just 1 line!
```typescript
import 'rsc-router/framework/entry.browser';
```

**entry.ssr.tsx** - Just 1 line!
```typescript
export { renderHTML } from 'rsc-router/framework/entry.ssr';
```

**Total setup code: 5 lines!**
**Framework handles: ~780 lines of production code**

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
