---
name: hooks
description: Client-side React hooks for navigation, loaders, and state in @rangojs/router
argument-hint: [hook-name]
---

# Client-Side React Hooks

All hooks are imported from `@rangojs/router` or `@rangojs/router/client`.

## Navigation Hooks

### useNavigation()

Track navigation state and control navigation:

```tsx
"use client";
import { useNavigation } from "@rangojs/router";

function NavIndicator() {
  const nav = useNavigation();

  // Full state
  nav.state;        // 'idle' | 'loading' | 'streaming'
  nav.isStreaming;  // boolean
  nav.location;     // Current URL
  nav.pendingUrl;   // Target URL during navigation (or null)

  // Methods
  nav.navigate("/products");           // Navigate programmatically
  nav.navigate("/products", { replace: true }); // Replace history
  nav.refresh();                       // Refresh current route

  return nav.state === 'loading' ? <Spinner /> : null;
}

// With selector for performance
function IsLoading() {
  const isLoading = useNavigation(nav => nav.state === 'loading');
  return isLoading ? <Spinner /> : null;
}
```

### useSegments()

Access current URL path and matched route segments:

```tsx
"use client";
import { useSegments } from "@rangojs/router";

function Breadcrumbs() {
  const { path, segmentIds, location } = useSegments();

  // path: ["/shop", "products", "123"]
  // segmentIds: ["shop-layout", "products-route"]
  // location: URL object

  return <nav>{path.join(" > ")}</nav>;
}

// With selector
const isShopRoute = useSegments(s => s.path[0] === "shop");
```

### useLinkStatus()

Track pending state inside a Link component:

```tsx
"use client";
import { Link, useLinkStatus } from "@rangojs/router/client";

function LoadingIndicator() {
  const { pending } = useLinkStatus();
  return pending ? <Spinner /> : null;
}

// Must be inside Link
<Link to="/dashboard">
  Dashboard
  <LoadingIndicator />
</Link>
```

## Data Hooks

### useLoader()

Access loader data (strict - data guaranteed):

```tsx
"use client";
import { useLoader } from "@rangojs/router";
import { ProductLoader } from "../loaders/product";

function ProductPrice() {
  const { data, isLoading, error } = useLoader(ProductLoader);

  // data: T (guaranteed - throws if not in context)
  // isLoading: boolean
  // error: Error | null

  return <span>${data.price}</span>;
}
```

**Precondition**: Loader must be registered on route via `loader()` helper.

Loaders can also be passed as props from server to client components:

```tsx
"use client";
import { useLoader } from "@rangojs/router/client";
import type { ProductLoader } from "../loaders";

// typeof infers the full data type from the loader definition
function ProductCard({ loader }: { loader: typeof ProductLoader }) {
  const { data } = useLoader(loader);
  return <h2>{data.product.name}</h2>;
}
```

### useFetchLoader()

Access loader with on-demand fetching (flexible):

```tsx
"use client";
import { useFetchLoader } from "@rangojs/router";
import { SearchLoader } from "../loaders/search";

function SearchResults() {
  const { data, load, isLoading, error } = useFetchLoader(SearchLoader);

  // data: T | undefined (may be undefined if not fetched)
  // load: (options?) => Promise<T>
  // refetch: alias for load

  const handleSearch = async (query: string) => {
    await load({ params: { query } });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch(e.target.value)} />
      {isLoading && <Spinner />}
      {data?.results.map(r => <Result key={r.id} {...r} />)}
    </div>
  );
}
```

**Load options**:
```tsx
await load({
  method: 'POST',              // GET, POST, PUT, PATCH, DELETE
  params: { query: 'test' },   // Query string (GET) or body (others)
  body: { data: 'value' },     // For POST/PUT/PATCH/DELETE
});
```

### useLoaderData()

Get all loader data in current context:

```tsx
"use client";
import { useLoaderData } from "@rangojs/router";

function DebugPanel() {
  const allData = useLoaderData();
  // Record<string, any> - Map of loader ID to data

  return <pre>{JSON.stringify(allData, null, 2)}</pre>;
}
```

## Handle Hooks

### useHandle()

Access accumulated handle data from route segments:

```tsx
"use client";
import { useHandle } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs";

function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // Array of { label, href } accumulated from layouts/routes

  return (
    <nav>
      {crumbs.map((c, i) => (
        <span key={i}>
          <a href={c.href}>{c.label}</a>
          {i < crumbs.length - 1 && " > "}
        </span>
      ))}
    </nav>
  );
}

// With selector
const lastCrumb = useHandle(Breadcrumbs, data => data.at(-1));
```

Handles can be passed as props from server to client components:

```tsx
// Server component
path("/dashboard", (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Dashboard", href: "/dashboard" });
  return <DashboardNav handle={Breadcrumbs} />;
})

// Client component — typeof infers the full Handle<T> type
"use client";
import { useHandle } from "@rangojs/router/client";
import type { Breadcrumbs } from "../handles";

function DashboardNav({ handle }: { handle: typeof Breadcrumbs }) {
  const crumbs = useHandle(handle);
  return <nav>{crumbs.map(c => <a href={c.href}>{c.label}</a>)}</nav>;
}
```

RSC serialization strips the `collect` function via `toJSON()`. On the client,
`useHandle()` recovers it from the module-level registry (populated when
`createHandle()` runs during module initialization).

## Action Hooks

### useAction()

Track state of server action invocations:

```tsx
"use client";
import { useAction } from "@rangojs/router";
import { addToCart } from "../actions/cart";

function AddToCartButton({ productId }: { productId: string }) {
  const { state, error, result } = useAction(addToCart);

  // state: 'idle' | 'loading' | 'streaming'
  // actionId: string | null
  // payload: unknown | null (input data)
  // error: Error | null
  // result: unknown | null (return value)

  return (
    <form action={addToCart}>
      <input type="hidden" name="productId" value={productId} />
      <button disabled={state === 'loading'}>
        {state === 'loading' ? 'Adding...' : 'Add to Cart'}
      </button>
      {error && <p className="error">{error.message}</p>}
    </form>
  );
}

// Match by string suffix (convenient but may be ambiguous)
const isLoading = useAction('addToCart', s => s.state === 'loading');
```

## State Hooks

### useLocationState()

Read type-safe state from history:

```tsx
"use client";
import { useLocationState, createLocationState } from "@rangojs/router";

// Define typed state (all export patterns supported)
export const ProductState = createLocationState<{
  name: string;
  price: number;
}>();

// Also valid: const ProductState = createLocationState<...>();
//             export { ProductState };
// Also valid: export { ProductState as MyState };

function ProductHeader() {
  const state = useLocationState(ProductState);
  // { name: string; price: number } | undefined

  if (state) {
    return <h1>{state.name} - ${state.price}</h1>;
  }
  return <h1>Loading...</h1>;
}
```

Pass state through Link:

```tsx
import { Link } from "@rangojs/router/client";
import { ProductState } from "./state";

<Link
  to="/product/123"
  state={[ProductState({ name: "Widget", price: 99 })]}
>
  View Product
</Link>
```

### useFlashState()

Read-once state that auto-clears after first read. Ideal for flash messages
(success/error notifications after redirect):

```tsx
"use client";
import { useFlashState } from "@rangojs/router/client";
import { FlashMessage } from "../location-states";

function FlashBanner() {
  const flash = useFlashState(FlashMessage);
  // { text: string } | undefined

  if (!flash) return null;
  return <div className="flash">{flash.text}</div>;
}
```

`useFlashState` reads the value synchronously during render, then clears it
from `history.state` via `replaceState` in a `useEffect`. Multiple components
reading the same flash definition all see the value. Pressing back/forward
will not re-show the flash since it was cleared.

Set flash state from the server via `redirect()` with state:

```tsx
// In a route handler
import { redirect, createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>();

// Handler
(ctx) => {
  return redirect("/dashboard", {
    state: [FlashMessage({ text: "Item saved!" })],
  });
}
```

Or via `ctx.setLocationState()` on any response:

```tsx
(ctx) => {
  ctx.setLocationState([FlashMessage({ text: "Welcome back!" })]);
  return <Dashboard />;
}
```

## Cache Hooks

### useClientCache()

Manually control client-side navigation cache:

```tsx
"use client";
import { useClientCache } from "@rangojs/router";

function SaveButton() {
  const { clear } = useClientCache();

  const handleSave = async () => {
    await fetch('/api/data', {
      method: 'POST',
      body: JSON.stringify(data)
    });

    // Invalidate cache after mutation
    clear();
  };

  return <button onClick={handleSave}>Save</button>;
}
```

**Use cases**: REST API mutations, WebSocket updates, non-RSC data changes.

## Outlet Components

### Outlet / ParallelOutlet

Render child content in layouts:

```tsx
import { Outlet, ParallelOutlet } from "@rangojs/router";

function DashboardLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>
        {children ?? <Outlet />}
      </main>
      <ParallelOutlet name="@notifications" />
    </div>
  );
}
```

### useOutlet()

Access outlet content programmatically:

```tsx
"use client";
import { useOutlet } from "@rangojs/router";

function ConditionalLayout() {
  const outlet = useOutlet();
  // ReactNode | null

  return outlet ? (
    <div className="with-content">{outlet}</div>
  ) : (
    <div className="empty">No content</div>
  );
}
```

## URL Hooks

### useHref()

Mount-aware href for client components inside `include()` scopes:

```tsx
"use client";
import { useHref, href, Link } from "@rangojs/router/client";

// Inside include("/shop", shopPatterns)
function ShopNav() {
  const href = useHref();

  return (
    <>
      {/* Local paths - auto-prefixed with /shop */}
      <Link to={href("/cart")}>Cart</Link>
      <Link to={href("/product/widget")}>Widget</Link>
    </>
  );
}
```

Use `useHref()` for local navigation. Use the bare `href()` function for absolute paths.

### useMount()

Returns the current `include()` mount path:

```tsx
"use client";
import { useMount } from "@rangojs/router/client";

function MountInfo() {
  const mount = useMount(); // "/shop" inside include("/shop", ...)
  return <span>Mounted at: {mount}</span>;
}
```

See `/links` for full URL generation guide including server-side `ctx.reverse`.

## Hook Summary

| Hook | Purpose | Returns |
|------|---------|---------|
| `useHref()` | Mount-aware href | `(path) => string` |
| `useMount()` | Current include() mount path | `string` |
| `useNavigation()` | Navigation state & control | state, navigate, refresh |
| `useSegments()` | URL path & segment IDs | path, segmentIds, location |
| `useLinkStatus()` | Link pending state | { pending } |
| `useLoader()` | Loader data (strict) | data, isLoading, error |
| `useFetchLoader()` | Loader with on-demand fetch | data, load, isLoading |
| `useLoaderData()` | All loader data | Record<string, any> |
| `useHandle()` | Accumulated handle data | T (handle type) |
| `useAction()` | Server action state | state, error, result |
| `useLocationState()` | History state (persists on back/forward) | T \| undefined |
| `useFlashState()` | Read-once state (auto-clears) | T \| undefined |
| `useClientCache()` | Cache control | { clear } |
