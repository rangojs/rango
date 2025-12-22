# Handle API Design Document

## Overview

The Handle API provides a mechanism for server-side route handlers to pass accumulated data to client components. Unlike loaders (which fetch data for specific routes), handles allow data to accumulate across all matched route segments and be consumed reactively on the client.

**Primary use case**: Breadcrumbs, page titles, meta tags, or any data that builds up across the route hierarchy.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER (RSC)                                    │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │ RootLayout   │    │ ShopLayout   │    │ ProductRoute │                   │
│  │ Handler      │───▶│ Handler      │───▶│ Handler      │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│         │                   │                   │                            │
│         ▼                   ▼                   ▼                            │
│  ctx.use(Breadcrumbs)  ctx.use(Breadcrumbs)  ctx.use(Breadcrumbs)           │
│  push({ Home, / })     push({ Shop, /shop }) push({ Laptop, /shop/laptop }) │
│         │                   │                   │                            │
│         └───────────────────┼───────────────────┘                            │
│                             ▼                                                │
│                   ┌─────────────────┐                                        │
│                   │  HandleStore    │                                        │
│                   │  (per request)  │                                        │
│                   └────────┬────────┘                                        │
│                            │                                                 │
│                            ▼                                                 │
│                   ┌─────────────────┐                                        │
│                   │  RSC Payload    │                                        │
│                   │  metadata.handles                                        │
│                   └────────┬────────┘                                        │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Browser)                                │
│                                                                              │
│                   ┌─────────────────┐                                        │
│                   │ updateHandleData│◀── NavigationProvider                  │
│                   └────────┬────────┘                                        │
│                            │                                                 │
│                            ▼                                                 │
│                   ┌─────────────────┐                                        │
│                   │ Handle Store    │                                        │
│                   │ (module-level)  │                                        │
│                   └────────┬────────┘                                        │
│                            │                                                 │
│         ┌──────────────────┼──────────────────┐                              │
│         ▼                  ▼                  ▼                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                       │
│  │ useHandle() │    │ useHandle() │    │ useHandle() │                       │
│  │ Component A │    │ Component B │    │ Component C │                       │
│  └─────────────┘    └─────────────┘    └─────────────┘                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### 1. Context-Based Storage (No AsyncLocalStorage)

**Decision**: Store handle data on the `HandlerContext` object via `__handleStore` property.

**Rationale**:

- AsyncLocalStorage requires Node.js and cannot be used in edge runtimes
- Context-based storage is explicit and avoids hidden global state
- The handle store is created per-request in entry.rsc.tsx and passed through the router

```typescript
// entry.rsc.tsx
const handleStore = createHandleStore();
const envWithHandleStore = { ...env, __handleStore: handleStore };
const match = await router.match(request, envWithHandleStore);

// getData() waits for settled internally, then returns collected data
// The data may contain unresolved promises that RSC will serialize and stream
const handles = handleStore.getData(); // Promise<HandleData>
```

### 1.1 Combined HandleStore (Promise Tracking + Data Storage)

**Decision**: A single `HandleStore` handles both tracking handler completion AND storing handle data.

**Rationale**:

- Streaming handlers (with `loading` component) are NOT awaited - they return pending promises
- We need to know when ALL handlers complete before collecting handle data
- The `track()` method registers pending handler promises without blocking
- The `settled` promise resolves when all tracked handlers have completed
- Only after `settled` can we safely call `getData()` to get complete handle data

```typescript
interface HandleStore {
  // Promise tracking - for streaming handlers
  track<T>(promise: Promise<T>): Promise<T>;
  readonly settled: Promise<void>;

  // Handle data storage
  push(handleName: string, segmentId: string, data: unknown): void;

  // Returns Promise<HandleData> - waits for settled first
  // The data may contain unresolved promises that RSC will stream
  getData(): Promise<HandleData>;
}
```

**Flow with streaming handlers:**

1. Request arrives, `HandleStore` created
2. Layout handler executes, pushes breadcrumb (value or promise), returns immediately (streaming)
3. `trackHandler()` registers the pending promise
4. Route handler executes, pushes breadcrumb (value or promise), returns immediately (streaming)
5. `trackHandler()` registers the pending promise
6. RSC rendering begins (handlers still resolving in background)
7. `handleStore.getData()` called - internally waits for `settled`, then returns data
8. Handle data (which may contain promises) is included in RSC payload
9. RSC serializes and streams the promises as they resolve

### 2. Unified ctx.use() API

**Decision**: Use the same `ctx.use()` method for both loaders and handles.

**Rationale**:

- Consistent API - developers don't need to learn two different patterns
- Type discrimination via the object structure (loaders have `__brand: "loader"`, handles have `handleName`)
- Loaders return promises, handles return bound push functions

```typescript
// Loaders - return Promise<T>
const product = await ctx.use(ProductLoader);

// Handles - return (data: T) => void
const push = ctx.use(Breadcrumbs);
push({ label: "Shop", href: "/shop" });
```

### 3. Segment-Scoped Data

**Decision**: Handle data is attributed to the segment where it was pushed.

**Rationale**:

- Enables proper ordering of accumulated data (parent → child)
- Supports partial updates during navigation (only revalidated segments push new data)
- Matches the mental model of route composition

```typescript
// Data structure: handleName -> segmentId -> entries[]
{
  "breadcrumbs": {
    "$root.layout": [{ label: "Home", href: "/" }],
    "shop.layout": [{ label: "Shop", href: "/shop" }],
    "shop.product": [{ label: "Laptop Pro", href: "/shop/laptop-pro" }]
  }
}
```

### 4. Reducer-Based Accumulation

**Decision**: Handles use a reducer pattern with configurable accumulation logic.

**Rationale**:

- Default behavior (array accumulation) handles the common case
- Custom reducers support advanced use cases (last-value-wins, merging, etc.)
- Matches familiar patterns from React/Redux

```typescript
// Default: collect into array
const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
// Result: [{ label: "Home" }, { label: "Shop" }, { label: "Product" }]

// Custom: last value wins
const PageTitle = createHandle<string, string>(
  "pageTitle",
  (acc, next) => next, // Reducer
  "Default Title" // Default value
);
// Result: "Product Details"
```

### 5. Reactive Client Updates

**Decision**: Use `useSyncExternalStore` for client-side handle access.

**Rationale**:

- Proper React 18+ concurrent rendering support
- Automatic re-renders when handle data changes (navigation, actions)
- SSR-compatible with identical server/client snapshots

## API Reference

### Server-Side

#### createHandle<TData, TAccumulated>

Creates a handle definition that can be used on both server and client.

```typescript
function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  reducer?: (acc: TAccumulated, next: TData) => TAccumulated,
  defaultValue?: TAccumulated
): Handle<TData, TAccumulated>;
```

#### ctx.use(handle)

Binds a handle to the current segment, returning a push function.

The push function accepts:
- **Direct value**: `push({ label: "Shop", href: "/shop" })`
- **Promise**: `push(fetchBreadcrumb())` - RSC will stream the resolved value
- **Async callback**: `push(() => fetchBreadcrumb())` - executed immediately, returns promise

```typescript
const push = ctx.use(Breadcrumbs);

// Direct value
push({ label: "Shop", href: "/shop" });

// Promise - useful for async data that can stream
push(fetchBreadcrumbAsync());

// Async callback - executed immediately
push(async () => {
  const data = await fetchData();
  return { label: data.name, href: data.url };
});
```

### Client-Side

#### useHandle(handle)

React hook to access accumulated handle data.

```typescript
function useHandle<TData, TAccumulated = TData[]>(
  handle: Handle<TData, TAccumulated>
): TAccumulated;
```

## Examples

### Example 1: Breadcrumbs

The classic use case - building a breadcrumb trail from matched route segments.

**Define the handle:**

```typescript
// handles/breadcrumbs.ts
import { createHandle } from "rsc-router/client";

export interface BreadcrumbItem {
  label: string;
  href: string;
}

export const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
```

**Push data from handlers:**

```typescript
// handlers/shop/routes/product.tsx
import { Breadcrumbs } from "@/handles/breadcrumbs";

export const ShopIndexHandler: RouteHandler = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Shop", href: "/shop" });

  return <ShopIndex />;
};

export const ProductHandler: RouteHandler = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Shop", href: "/shop" });
  push({ label: product.name, href: `/shop/product/${ctx.params.slug}` });

  return <ProductPage product={product} />;
};
```

**Consume on client:**

```typescript
// components/BreadcrumbNav.tsx
"use client";

import { useHandle, Link } from "rsc-router/client";
import { Breadcrumbs } from "@/handles/breadcrumbs";

export function BreadcrumbNav() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb">
      <ol>
        {breadcrumbs.map((crumb, i) => (
          <li key={crumb.href}>
            {i === breadcrumbs.length - 1 ? (
              <span>{crumb.label}</span>
            ) : (
              <Link to={crumb.href}>{crumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

### Example 2: Page Title (Last Value Wins)

When you want only the most specific value, not accumulation.

```typescript
// handles/page-title.ts
import { createHandle } from "rsc-router/client";

export const PageTitle = createHandle<string, string>(
  "pageTitle",
  (acc, next) => next, // Last value wins
  "My App" // Default title
);
```

```typescript
// handlers/dashboard.tsx
const push = ctx.use(PageTitle);
push("Dashboard");

// handlers/dashboard/settings.tsx
const push = ctx.use(PageTitle);
push("Settings - Dashboard");
// Result: "Settings - Dashboard" (not accumulated)
```

```typescript
// components/DocumentHead.tsx
"use client";

import { useHandle } from "rsc-router/client";
import { PageTitle } from "@/handles/page-title";

export function DocumentHead() {
  const title = useHandle(PageTitle);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}
```

### Example 3: Permission Flags (Set Union)

Accumulating permission flags across route segments.

```typescript
// handles/permissions.ts
import { createHandle } from "rsc-router/client";

type Permission = "read" | "write" | "admin";

export const Permissions = createHandle<Permission, Set<Permission>>(
  "permissions",
  (acc, next) => new Set([...acc, next]), // Union of sets
  new Set()
);
```

```typescript
// handlers/admin.tsx (layout)
const push = ctx.use(Permissions);
push("read"); // Base permission for admin area

// handlers/admin/users.tsx
const push = ctx.use(Permissions);
push("write"); // Additional permission for user management
```

```typescript
// components/PermissionGate.tsx
"use client";

import { useHandle } from "rsc-router/client";
import { Permissions } from "@/handles/permissions";

export function PermissionGate({
  requires,
  children
}: {
  requires: Permission;
  children: React.ReactNode
}) {
  const permissions = useHandle(Permissions);

  if (!permissions.has(requires)) {
    return <AccessDenied />;
  }

  return children;
}
```

### Example 4: Meta Tags (Object Merge)

Building meta tag objects that merge across segments.

```typescript
// handles/meta.ts
import { createHandle } from "rsc-router/client";

interface MetaTags {
  title?: string;
  description?: string;
  ogImage?: string;
  robots?: string;
}

export const Meta = createHandle<Partial<MetaTags>, MetaTags>(
  "meta",
  (acc, next) => ({ ...acc, ...next }), // Shallow merge
  { robots: "index,follow" } // Defaults
);
```

```typescript
// handlers/blog.tsx (layout)
const push = ctx.use(Meta);
push({
  title: "Blog",
  description: "Our latest articles",
});

// handlers/blog/post.tsx
const push = ctx.use(Meta);
push({
  title: post.title,
  description: post.excerpt,
  ogImage: post.coverImage,
});
// Result: { title: "...", description: "...", ogImage: "...", robots: "index,follow" }
```

## File Structure

```
packages/rsc-router/src/
├── handle.ts                    # createHandle function + Handle types
├── types.ts                     # RouterInternalContext, HandleData types
├── server/
│   └── handle-store.ts          # HandleStore (promise tracking + data storage)
├── router.ts                    # ctx.use() implementation, trackHandler helper
├── rsc/
│   └── index.ts                 # Creates HandleStore per request, includes in payload
└── browser/
    └── react/
        ├── use-handle.ts        # useHandle hook
        └── navigation-context.tsx  # updateHandleData integration
```

## Data Flow

1. **Request Start**: `rsc/index.ts` creates a `HandleStore` and passes it via `env.__handleStore`
2. **Handler Tracking**: Router's `trackHandler()` registers streaming handler promises
3. **Segment Execution**: Each handler calls `ctx.use(Handle)` to get a bound push function
4. **Data Push**: Push function calls `store.push(handleName, segmentId, data)` - data can be value or promise
5. **Payload Assembly**: `handleStore.getData()` waits for `settled`, returns collected data (may contain promises)
6. **RSC Streaming**: RSC serializes the payload, streaming any promise values as they resolve
7. **Client Hydration**: `NavigationProvider` calls `updateHandleData()` with initial payload
8. **Navigation Updates**: Each RSC response triggers `updateHandleData()` with new data
9. **Component Render**: `useHandle()` returns accumulated value, re-renders on changes

## Import Paths

```typescript
// Server handlers - use either
import { createHandle } from "rsc-router/server";
import { createHandle } from "rsc-router/client"; // Works in RSC context too

// Client components
import { createHandle, useHandle } from "rsc-router/client";
```

Note: Loader files should import `createHandle` from `"rsc-router/client"` to avoid bundling server-only code when the loader is imported by client components.
