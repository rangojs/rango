# RSC Router Framework

Out-of-the-box framework integration for React Server Components with Vite.

## Overview

This directory provides production-ready entry points for using RSC Router with `@vitejs/plugin-rsc`. These files handle:

- ✅ **RSC Stream Generation** - Server-side component serialization
- ✅ **Partial Rendering** - Differential updates for navigation
- ✅ **SPA Navigation** - Automatic link interception
- ✅ **SSR with Hydration** - HTML generation with payload injection
- ✅ **Segment Management** - Automatic tree reconstruction

## Quick Start

### 1. Install Dependencies

```bash
npm install rsc-router @vitejs/plugin-rsc rsc-html-stream
```

### 2. Configure Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import rsc from '@vitejs/plugin-rsc';
import react from '@vitejs/plugin-react';

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

### 3. Create Entry Points

**src/entry.rsc.tsx** - Use the framework helper:

```typescript
import { createRSCRouter, route } from 'rsc-router';
import { createRSCHandler } from 'rsc-router/framework';

// Configure your router
const router = createRSCRouter();

router.route(routes).map({
  [route.layout]: RootLayout,
  home: () => <HomePage />,
  blog: () => <BlogPage />
});

// Export handler
export default createRSCHandler(router);
```

**src/entry.browser.tsx** - Use the framework helper:

```typescript
// Just import and it auto-initializes!
import 'rsc-router/framework/entry.browser';
```

**src/entry.ssr.tsx** - Re-export the framework module:

```typescript
export { renderHTML } from 'rsc-router/framework/entry.ssr';
```

### 4. Run Your App

```bash
npm run dev
```

That's it! You now have:
- ✅ SPA navigation (links don't reload page)
- ✅ Partial rendering (only changed segments sent)
- ✅ Automatic segment management
- ✅ Full RSC support

## How It Works

### Server (entry.rsc.tsx)

1. Receives request
2. Handles server actions (if POST)
3. Checks for partial rendering request (`_rsc_partial` parameter)
4. Uses `router.matchPartial()` for differential updates
5. Uses `router.match()` for full renders
6. Builds segment map and renders to RSC stream
7. Returns RSC stream or delegates to SSR for HTML

### Browser (entry.browser.tsx)

1. Hydrates from SSR-rendered HTML
2. Initializes SegmentStore with initial segments
3. Intercepts link clicks for SPA navigation
4. Fetches with `_rsc_partial` parameter on navigation
5. Receives partial payload with only changed segments
6. Merges segments and reconstructs React tree
7. Renders updated UI without full page reload

### SSR (entry.ssr.tsx)

1. Receives RSC stream from entry.rsc
2. Deserializes RSC stream to React VDOM
3. Renders React VDOM to HTML stream
4. Injects RSC payload for client hydration
5. Returns HTML stream

## Features

### Automatic Partial Rendering

When navigating between routes:

```
User on: /blog
Clicks: /blog/post-123

Browser:
  → GET /blog/post-123?_rsc_partial=true&_rsc_prev=/blog

Server (entry.rsc.tsx):
  → router.matchPartial(request, '/blog')
  → Computes differential: L0, L1 preserved, R2 changed
  → Returns only R2 segment

Browser:
  → Receives partial payload
  → Keeps L0, L1 segments
  → Updates R2 segment
  → Reconstructs tree
  → Renders (no page reload!)
```

### Link Interception

Links are automatically intercepted for SPA navigation:

```tsx
// This just works - no special Link component needed!
<a href="/blog">Blog</a>

// Clicking triggers:
// 1. event.preventDefault()
// 2. history.pushState(null, '', '/blog')
// 3. Fetch with _rsc_partial
// 4. Update UI
```

### Segment-Based Rendering

Layouts and routes are automatically managed as segments:

```typescript
// Server builds segments
const segments = [
  { id: 'L0', type: 'layout', component: RootLayout },
  { id: 'L1', type: 'layout', component: BlogLayout },
  { id: 'R2', type: 'route', component: BlogPost },
  { id: 'P3', type: 'parallel', component: Sidebar, slot: '@sidebar' }
];

// Client reconstructs tree with OutletProvider
<RootLayout>
  <BlogLayout>
    <>
      <BlogPost />
      <Sidebar />
    </>
  </BlogLayout>
</RootLayout>
```

## API Reference

### createRSCHandler(router)

Creates a request handler for the RSC environment.

**Parameters:**
- `router` - Configured RSCRouter instance

**Returns:** Request handler function

### initializeApp()

Initializes the browser application (auto-called in entry.browser.tsx).

Handles:
- Initial payload deserialization
- Segment store initialization
- Navigation setup
- Server callback configuration

## Files

- `types.ts` - TypeScript types for RscPayload
- `entry.rsc.tsx` - Server RSC stream generation
- `entry.browser.tsx` - Client hydration and SPA navigation
- `entry.ssr.tsx` - SSR HTML generation
- `README.md` - This file

## Learn More

- [Router Documentation](../README.md)
- [Partial Rendering Guide](../../.implementation-changesets/)
- [vite-plugin-rsc Documentation](https://github.com/hi-ogawa/vite-plugins/tree/main/packages/vite-plugin-rsc)
