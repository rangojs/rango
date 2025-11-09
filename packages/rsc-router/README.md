# RSC Router

A React Server Components router with partial rendering support, designed for serverless environments.

## Features

- 🚀 **Lazy Loading** - Optimized for serverless with minimal cold starts
- 🎯 **Partial Rendering** - Render only changed segments for optimal performance
- 🔒 **Secure by Default** - Middleware always runs, regardless of partial/full render
- 📦 **Tree Shaking** - Separate client/server exports for optimal bundle size
- 🎭 **Parallel Routes** - Support for named slots (@sidebar, @modal, etc.)
- 🪆 **Nested Layouts** - Multiple layout composition with array syntax

## Installation

```bash
pnpm add rsc-router
```

## Usage

### Server-side (routes.tsx)

```typescript
import { createRSCRouter, route } from 'rsc-router/server';

// Define routes
const blogRoutes = route({
  index: '/',
  show: '/:slug'
});

// Create router
const app = createRSCRouter();

// Mount routes with middleware
app
  .route('/blog', blogRoutes)
  .use(auth())
  .use(logger())
  .map({
    // Layouts can be single or array
    [route.layout]: [AppShell, BlogLayout],

    // Route handlers
    index: () => <BlogList />,
    show: (ctx) => <BlogPost slug={ctx.params.slug} />,

    // Parallel routes
    [route.parallel]: {
      '@sidebar': () => <BlogSidebar />,
      '@notifications': () => <NotificationPanel />
    }
  });

export default app;
```

### Client-side (layouts)

```typescript
import { Outlet } from 'rsc-router/client';

export function BlogLayout() {
  return (
    <div className="blog-layout">
      <header>Blog Header</header>
      <main>
        <Outlet /> {/* Renders child segments */}
      </main>
      <footer>Blog Footer</footer>
    </div>
  );
}
```

## Architecture

### Segment-based Rendering

Routes are broken into indexed segments (L0, L1, R2, etc.) that can be:
- **L**: Layout segments
- **R**: Route content segments
- **P**: Parallel route segments (@name)

### Client-Server Protocol

1. Client reports what segments it has: `?_has=L0,L1,R2`
2. Server computes what changed and sends only updates
3. Client reconciles segments based on server response

### Performance Optimizations

- Linear router matching (optimized for serverless)
- JIT compilation of route patterns
- Lazy loading of handlers and middleware
- Streaming partial renders

## Development

```bash
# Build package
pnpm build

# Watch mode
pnpm dev

# Type checking
pnpm type-check
```

## License

MIT