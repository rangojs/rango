# Handle API Design (TEMP - DELETE BEFORE PR)

## Overview

A flexible API for passing typed data from server (loaders, middleware, handlers, RSC) to client components, with automatic collection and reactive updates on navigation.

## API

### Creating a Handle

```typescript
import { createHandle } from 'rsc-router';

// Simple - collects into array (default reducer)
const breadcrumbs = createHandle<Crumb>('breadcrumbs');

// With custom reducer
const permissions = createHandle<string[], string[]>(
  'permissions',
  (acc, next) => [...new Set([...acc, ...next])]
);

// Type signature
function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  reducer?: (acc: TAccumulated, next: TData) => TAccumulated
): Handle<TData, TAccumulated>;
```

### Calling on Server

Can be called from anywhere during server render:
- Loaders
- Middleware
- Route handlers
- Server components

```typescript
// Sync data
breadcrumbs({ label: 'Shop', href: '/shop' });

// Async data
breadcrumbs(async () => ({
  label: await getProductName(id),
  href: `/product/${id}`
}));

// Multiple calls accumulate
permissions(['read', 'write']);
permissions(['admin']);
```

### Consuming on Client

```typescript
import { useHandle } from 'rsc-router/client';

function BreadcrumbNav() {
  // Get all accumulated data
  const crumbs = useHandle(breadcrumbs);

  // With selector
  const lastCrumb = useHandle(breadcrumbs, c => c[c.length - 1]);

  return <nav>{crumbs.map(c => <a href={c.href}>{c.label}</a>)}</nav>;
}
```

## Behavior

### Document Requests (SSR)
- **Blocking**: All handles resolve before sending response
- Important for metadata like `<title>`, `<meta>`

### Client Navigation (SPA)
- **Async**: Navigation proceeds, `useHandle` updates when all entries resolve
- Reactive: Updates automatically when navigation completes

### Order
- Call order during render = array order
- Natural: layouts render before routes (top-down)
- Consumer doesn't know/care which segment sent data

## Data Flow

1. Server renders, handles are called
2. Handle data collected in request context
3. Async handles awaited (blocking for SSR, parallel for SPA nav)
4. Data serialized in RSC payload metadata
5. Client receives payload, handle store updated
6. `useHandle` consumers re-render with new data

## Implementation Notes

### Server Side

```typescript
// Request-scoped storage for handle data
interface HandleStore {
  [handleName: string]: {
    entries: Array<TData | Promise<TData>>;
    reducer?: (acc: any, next: any) => any;
  };
}

// The handle function returned by createHandle
function handle(data: TData | (() => TData | Promise<TData>)) {
  const store = getRequestHandleStore();
  const entry = typeof data === 'function' ? data() : data;
  store[name].entries.push(entry);
}
```

### RSC Payload

```typescript
// Added to payload metadata
{
  root: <ReactTree />,
  metadata: {
    segments: [...],
    matched: [...],
    handles: {
      breadcrumbs: [{ label: 'Shop', href: '/shop' }, { label: 'Product', href: '/...' }],
      permissions: ['read', 'write', 'admin']
    }
  }
}
```

### Client Side

```typescript
// Navigation store holds current handle data
interface NavigationState {
  // ... existing fields
  handles: Record<string, any>;
}

// Hook reads from store, subscribes to updates
function useHandle<T, A>(handle: Handle<T, A>, selector?: (a: A) => any) {
  const store = useNavigationStore();
  const data = store.handles[handle.name] ?? handle.defaultValue;
  return selector ? selector(data) : data;
}
```

## Open Questions

1. **Default value** - What does `useHandle` return before any data arrives?
   - Empty array for default reducer?
   - `undefined`?
   - Configurable in `createHandle`?

2. **Error handling** - What if an async handle throws?
   - Skip that entry?
   - Propagate to error boundary?
   - Include error in result?

3. **SSR hydration** - How to ensure client hydrates with same data?
   - Serialize handle data in HTML?
   - Part of RSC payload that hydrates?

4. **Stale data during navigation** - Show previous data while loading?
   - Like stale-while-revalidate?
   - Clear immediately on nav start?

5. **Handle identity** - Same handle called from different files?
   - Works fine if same `createHandle` instance is imported
   - Name collision if different instances with same name?

## Use Cases

### Child-to-Parent Communication (Layout Configuration)

Handles enable data to flow UP from routes to parent layouts - normally hard in React:

```typescript
const layoutConfig = createHandle<LayoutConfig>('layoutConfig');

// In product detail route - tells layout about its content
layoutConfig({
  slides: product.images.length,
  fullWidth: true,
  pagination: { current: 1, total: 10 }
});

// In parent layout - receives config from child routes
function ShopLayout({ children }) {
  const config = useHandle(layoutConfig, c => c[c.length - 1]); // deepest wins

  return (
    <div className={config?.fullWidth ? 'full' : 'with-sidebar'}>
      {config?.slides && <SlideIndicator count={config.slides} />}
      {children}
      {config?.pagination && <Pagination {...config.pagination} />}
    </div>
  );
}
```

**Examples:**
- **Pagination**: Route tells layout page count/current page
- **Menu items**: Route adds context-specific items to header
- **Render mode**: "modal", "drawer", "full-page", "sidebar"
- **HTML boundaries**: Content regions for CSS containment
- **Slide/carousel count**: Layout renders indicators based on route content

### Breadcrumbs
```typescript
const breadcrumbs = createHandle<{ label: string; href: string }>('breadcrumbs');

// In shop layout loader
breadcrumbs({ label: 'Shop', href: '/shop' });

// In product route handler
breadcrumbs(async (ctx) => ({
  label: await db.product.findUnique({ where: { id: ctx.params.id } }).then(p => p.name),
  href: `/shop/${ctx.params.id}`
}));
```

### Page Metadata
```typescript
const meta = createHandle<MetaTag>('meta');

meta({ title: 'My Shop' });
meta({ description: 'Best products' });
meta({ ogImage: '/og.png' });

// In root layout
function RootLayout() {
  const tags = useHandle(meta);
  return (
    <html>
      <head>
        <title>{tags.find(t => t.title)?.title}</title>
        {tags.map(t => t.description && <meta name="description" content={t.description} />)}
      </head>
      ...
    </html>
  );
}
```

### Permissions/Auth Context
```typescript
const permissions = createHandle<string[], string[]>(
  'permissions',
  (acc, next) => [...new Set([...acc, ...next])]
);

// Middleware adds base permissions
permissions(['authenticated']);

// Route-specific permissions
permissions(['can_edit_product']);

// Component checks
function EditButton() {
  const perms = useHandle(permissions);
  if (!perms.includes('can_edit_product')) return null;
  return <button>Edit</button>;
}
```

## Files to Modify

- [ ] `packages/rsc-router/src/handle.ts` - createHandle, Handle type
- [ ] `packages/rsc-router/src/server/handle-context.ts` - request-scoped storage
- [ ] `packages/rsc-router/src/router.ts` - collect handles during render
- [ ] `packages/rsc-router/src/browser/navigation-store.ts` - store handle data
- [ ] `packages/rsc-router/src/browser/react/use-handle.ts` - useHandle hook
- [ ] `packages/rsc-router/src/index.ts` - export createHandle
- [ ] `packages/rsc-router/src/client.tsx` - export useHandle
- [ ] `examples/vite-rsc-demo/` - demo usage
