---
name: hooks
description: Client-side React hooks for navigation, loaders, and state in @rangojs/router. Use when a client component needs the current URL, params, search params, navigation state, or loader data — e.g. "how do I read the route param in a component".
argument-hint: [hook-name]
---

# Client-Side React Hooks

Import the hooks and components in this skill from `@rangojs/router/client`.
The root `@rangojs/router` entrypoint is for server/RSC APIs and shared types.

## Navigation Hooks

### useNavigation()

Track reactive navigation state (state-only, no actions):

```tsx
"use client";
import { useNavigation } from "@rangojs/router/client";

function NavIndicator() {
  const nav = useNavigation();

  // State properties
  nav.state; // 'idle' | 'loading'
  nav.isStreaming; // boolean
  nav.location; // Current URL
  nav.pendingUrl; // Target URL during navigation (or null)

  return nav.state === "loading" ? <Spinner /> : null;
}

// With selector for performance (re-renders only when selected value changes)
function IsLoading() {
  const isLoading = useNavigation((nav) => nav.state === "loading");
  return isLoading ? <Spinner /> : null;
}
```

### useRouter()

Access stable router actions (never causes re-renders):

```tsx
"use client";
import { useRouter } from "@rangojs/router/client";

function NavigationControls() {
  const router = useRouter();

  router.push("/products"); // Navigate (adds history entry)
  router.replace("/login"); // Navigate (replaces history entry)
  router.refresh(); // Re-fetch current route data
  router.prefetch("/dashboard"); // Prefetch for faster navigation
  router.back(); // Go back in history
  router.forward(); // Go forward in history
}
```

#### Skipping revalidation

Pass `revalidate: false` to skip the RSC server fetch for same-pathname navigations (search param or hash changes). The URL updates and all hooks re-render, but server components stay as-is.

```tsx
// Update search params without server round-trip
router.push("/products?color=blue", { revalidate: false });
router.replace("/products?page=3", { revalidate: false });
```

If the pathname changes, `revalidate: false` is silently ignored and a full navigation occurs. This also works on `<Link>`:

```tsx
<Link to="/products?color=blue" revalidate={false}>
  Blue
</Link>
```

Plain `<a>` tags can opt in via `data-revalidate="false"`.

### useSegments()

Access current URL path and matched route segments:

```tsx
"use client";
import { useSegments } from "@rangojs/router/client";

function Breadcrumbs() {
  const { path, segmentIds, location } = useSegments();

  // path: ["shop", "products", "123"] (split on "/", no leading slash on any element)
  // segmentIds: ["L0", "L0L1", "L0L1R0"] (opaque internal short-codes, not route names)
  // location: URL object

  return <nav>{path.join(" > ")}</nav>;
}

// With selector
const isShopRoute = useSegments((s) => s.path[0] === "shop");
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
</Link>;
```

## Data Hooks

### useLoader()

Access loader data (strict - data guaranteed):

```tsx
"use client";
import { useLoader } from "@rangojs/router/client";
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
import { useFetchLoader } from "@rangojs/router/client";
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
      {data?.results.map((r) => (
        <Result key={r.id} {...r} />
      ))}
    </div>
  );
}
```

**Shared refetch behavior**:

When the loader is registered on the route via `loader()`, a plain
`load()` call (no options, or a trivially-defaulted GET with no
`params` and no `body`) broadcasts its result to every component
reading the same loader id. Layout, page, and parallel-slot reads
all converge on the new value:

```tsx
// Layout button calls load() — the page read below sees the update too.
function Layout() {
  const { data, load } = useLoader(CartLoader);
  return <button onClick={() => load()}>Refresh ({data.count})</button>;
}
function Page() {
  const { data } = useLoader(CartLoader); // updates with the layout's load()
  return <span>{data.count} items</span>;
}
```

`isLoading` and `error` follow the same scope. `throwOnError: true`
render-throws are scoped to the **originating** hook — sibling readers
see the error in their `error` state but their boundaries are not
triggered by someone else's failure. A successful follow-up `load()`
clears the shared error.

**`load()` calls that stay local** (no broadcast, per-hook state, same
semantics as the old per-component `useState`):

- `load({ params: { ... } })` — explicit params.
- `load({ method: "POST", body })` — mutations.
- Any `load()` on a `useFetchLoader(loader)` whose loader is **not**
  registered on the current route. Two unrelated components calling
  `load()` on the same fetchable-but-unregistered loader keep
  independent results.

So the search/list pattern still works — two components calling
`load({ params: { q } })` with different `q` values each keep their
own result; they do not collapse to last-write-wins through a shared
store.

**Scoping refetch with a `key`**:

Pass a `key` to partition the shared refresh store. Only hooks using the
**same** `key` refresh together when one of them calls `load()`. This is a
client-side refresh identity only — it never changes the request sent to the
server, and is unrelated to the server `cache({ key })` option and to
`revalidate()`.

```tsx
// Two independent dashboards using the same loader. Without a key, one
// dashboard's load() would flip the other's spinner and value. With a key,
// they refresh independently.
function Dashboard({ id }: { id: string }) {
  const { data, load } = useLoader(StatsLoader, { key: `dashboard:${id}` });
  return <button onClick={() => load()}>Refresh {data.total}</button>;
}
```

The `key` widens sharing in two ways the default cannot:

- **Parameterized GETs share.** `useFetchLoader(SearchLoader, { key: q })`
  with the same `q` in two components share one result and refresh together —
  a keyed `load({ params: { q } })` broadcasts to the group instead of staying
  local. (Mutations — non-GET or `body` — stay local even with a key.)
- **Unregistered loaders share.** A `key` makes `useFetchLoader` of a loader
  that is **not** registered on the route share too, letting unrelated
  components opt into a common refresh group.

Lifecycle: a keyed read of an unregistered loader is reference-counted — its
shared value lives as long as at least one component using that key is mounted.
A persistent component (e.g. a header) keeps the value across navigations; a
route-scoped component's value is reclaimed when it unmounts. Registered-loader
reads (keyed or not) reset on navigation from fresh route data, as before.

**Refreshing multiple loaders together (`refreshGroup` + `useRefreshLoaders`)**:

`key` groups readers of one loader. To refresh **different** loaders together,
tag them with a shared `refreshGroup` name and trigger them with
`useRefreshLoaders()`. The hook takes no argument; you pass the group(s) to the
function it returns, so one `useRefreshLoaders()` can refresh different groups
depending on context. A read may carry **several** tags — pass an array — and is
refreshed when **any** of its groups is refreshed:

```tsx
function Profile() {
  const { data } = useLoader(ProfileLoader, {
    key: userId,
    refreshGroup: "account",
  });
  return <span>{data.name}</span>;
}
function Orders() {
  // Tagged into two groups: refreshed by "account" (the whole set) or the
  // finer "orders" tag.
  const { data } = useLoader(OrdersLoader, {
    key: userId,
    refreshGroup: ["account", "orders"],
  });
  return <span>{data.count} orders</span>;
}
function RefreshButtons() {
  const refresh = useRefreshLoaders();
  return (
    <>
      <button onClick={() => refresh("account")}>Refresh account</button>
      <button onClick={() => refresh("orders")}>Refresh orders only</button>
      <button onClick={() => refresh(["account", "orders"])}>
        Refresh both
      </button>
    </>
  );
}
```

`refresh(groups)` accepts one name or an array and re-runs every currently-mounted
member tagged with **any** of them, with a **plain GET** against the current route
URL — no params, no body, no mutation methods, because a group spans loaders with
different shapes. A member that sits in two of the requested groups is fetched
once (members are unioned and deduped by read). It returns a promise that resolves
when all members settle and **rejects with an `AggregateError`** if any fail;
group refresh never render-throws, so handle failures at the await site
(`await refresh("account").catch(...)`). Each failing member also exposes its
error via its own read's `error`.

Multiple tags give you granular vs. whole-set refresh from one place: a coarse
tag (`"account"`) covers everything, while a finer tag (`"orders"`) targets a
subset. Sharing within a group is opt-in via `key`: members that share a `key`
share one value (and one fetch); a grouped reader **without** a `key` gets its own
private bucket, so a group refresh updates only that read and never leaks into
unrelated unkeyed reads of the same loader. A bucket may belong to several groups
at once (one read tagged with multiple names, or different reads tagging the same
keyed bucket with different names). Keep parameterized loaders on the single-loader
`key` — a plain-GET group refresh sends no params.

**Load options**:

```tsx
// JSON body — sent as application/json, available as ctx.body on the server
await load({
  method: "POST",
  params: { query: "test" },
  body: { data: "value" },
});

// FormData body — sent as multipart/form-data, available as ctx.formData on the server.
// Automatically detected: when body is a FormData instance, the request switches
// to multipart/form-data to preserve File objects and binary data.
const formData = new FormData();
formData.append("file", fileInput.files[0]);
await load({ method: "POST", body: formData });
```

**Body type auto-switching**: The `load()` function inspects the `body` value to
choose the encoding. If `body instanceof FormData`, the request is sent as
`multipart/form-data` (browser sets the boundary header automatically). Otherwise
the body is JSON-serialized and sent with `Content-Type: application/json`. On the
server, JSON bodies are available via `ctx.body` and FormData bodies via `ctx.formData`.

**File upload example**:

```tsx
"use client";
import { useFetchLoader } from "@rangojs/router/client";
import { FileUploadLoader } from "../loaders/upload";

function FileUploader() {
  const { data, load, isLoading } = useFetchLoader(FileUploadLoader);
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = async (formData: FormData) => {
    await load({ method: "POST", body: formData });
    formRef.current?.reset();
  };

  return (
    <form ref={formRef} action={handleSubmit}>
      <input type="file" name="file" />
      <button type="submit" disabled={isLoading}>
        {isLoading ? "Uploading..." : "Upload"}
      </button>
      {data?.uploadedFile && <p>Uploaded: {data.uploadedFile.name}</p>}
    </form>
  );
}
```

Server-side loader for the upload:

```typescript
import { createLoader } from "@rangojs/router";

export const FileUploadLoader = createLoader(async (ctx) => {
  "use server";

  const file = ctx.formData?.get("file") as File | null;
  if (file && file.size > 0) {
    // Process file (save to R2, D1, etc.)
    return { uploadedFile: { name: file.name, size: file.size } };
  }
  return { uploadedFile: null };
}, true); // true = fetchable (can be called from the client via load())
```

## Handle Hooks

### useHandle()

Access accumulated handle data from route segments:

```tsx
"use client";
import { useHandle, Breadcrumbs } from "@rangojs/router/client";

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
const lastCrumb = useHandle(Breadcrumbs, (data) => data.at(-1));
```

Handles can be passed as props from server to client components:

```tsx
// Server component
path("/dashboard", (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Dashboard", href: "/dashboard" });
  return <DashboardNav handle={Breadcrumbs} />;
});
```

```tsx
// Client component — typeof infers the full Handle<T> type
"use client";
import { useHandle, type Breadcrumbs } from "@rangojs/router/client";

function DashboardNav({ handle }: { handle: typeof Breadcrumbs }) {
  const crumbs = useHandle(handle);
  return (
    <nav>
      {crumbs.map((c) => (
        <a href={c.href}>{c.label}</a>
      ))}
    </nav>
  );
}
```

RSC serialization strips the `collect` function via `toJSON()`. On the client,
`useHandle()` recovers it from the module-level registry (populated when
`createHandle()` runs during module initialization).

## Action Hooks

For the full server-action guide (defining actions, `useActionState`,
`useOptimistic`, validation, revalidation, error handling, file uploads),
see `/server-actions`. `useAction()` below is a Rango-specific hook for
tracking actions called outside a `<form action={...}>` flow.

### useAction()

Track state of server action invocations:

```tsx
"use client";
import { useAction } from "@rangojs/router/client";
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
      <button disabled={state === "loading"}>
        {state === "loading" ? "Adding..." : "Add to Cart"}
      </button>
      {error && <p className="error">{error.message}</p>}
    </form>
  );
}

// Match by string suffix (convenient but may be ambiguous)
const isLoading = useAction("addToCart", (s) => s.state === "loading");
```

## State Hooks

### useLocationState()

Read type-safe state from history:

```tsx
"use client";
import { useLocationState, createLocationState } from "@rangojs/router/client";

// Define typed state (all export patterns supported)
// Keys are auto-injected by the Vite plugin -- no manual key needed.
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
    return (
      <h1>
        {state.name} - ${state.price}
      </h1>
    );
  }
  return <h1>Loading...</h1>;
}
```

Pass state through Link:

```tsx
import { Link } from "@rangojs/router/client";
import { ProductState } from "./state";

<Link to="/product/123" state={[ProductState({ name: "Widget", price: 99 })]}>
  View Product
</Link>;
```

Pass typed state just in time (getter evaluated at click time, not render time):

```tsx
"use client"; // JIT state requires a client component (getter can't cross RSC boundary)

import { Link } from "@rangojs/router/client";
import { ProductState } from "./state";

// The getter is stored lazily and only called when the user clicks the link.
// This is useful for capturing values that change after render (e.g., scroll
// position, form state, ref values).
<Link
  to="/product/123"
  state={[ProductState(() => ({ name: product.name, price: product.price }))]}
>
  View Product
</Link>;
```

Plain state can also be evaluated just in time (also requires a client component):

```tsx
<Link to="/product/123" state={() => ({ from: window.location.pathname })}>
  View Product
</Link>
```

### Flash State (read-once)

Create a location state with `{ flash: true }` for read-once state that
auto-clears after first render. Ideal for flash messages (success/error
notifications after redirect):

```tsx
// location-states.ts
import { createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});
```

Read flash state with `useLocationState` (same hook as persistent state):

```tsx
"use client";
import { useLocationState } from "@rangojs/router/client";
import { FlashMessage } from "../location-states";

function FlashBanner() {
  const flash = useLocationState(FlashMessage);
  // { text: string } | undefined

  if (!flash) return null;
  return <div className="flash">{flash.text}</div>;
}
```

Flash behavior is determined by the definition (`{ flash: true }`), not by which
hook reads it. `useLocationState` reads the value synchronously during render,
then clears it from `history.state` via `replaceState` in a `useEffect`.
Multiple components reading the same flash definition all see the value.
Pressing back/forward will not re-show the flash since it was cleared.

Set flash state from the server via `redirect()` with state:

```tsx
// In a route handler
import { redirect, createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});

// Handler
(ctx) => {
  return redirect("/dashboard", {
    state: [FlashMessage({ text: "Item saved!" })],
  });
};
```

Or via `ctx.setLocationState()` on any response:

```tsx
(ctx) => {
  ctx.setLocationState(FlashMessage({ text: "Welcome back!" }));
  return <Dashboard />;
};
```

### .read() (non-hook access)

Read current location state outside React components (client-side only):

```tsx
import { FlashMessage, ProductState } from "../location-states";

// Returns TState | undefined. Returns undefined during SSR.
const flash = FlashMessage.read();
const product = ProductState.read();
```

> **Hydration:** `.read()` returns `undefined` on the server but may return
> a real value on the first client render (history state survives reload).
> Do not call `.read()` directly during the initial render of a component;
> call it from an event handler or inside a `useEffect` post-mount. For
> reactive hydration-safe access, use `useLocationState()` instead.

### .write() / .delete() (static, non-reactive)

Static counterparts to `.read()`. Both mutate the current history entry's
`history.state` via `replaceState`, preserving any other keys (router
bookkeeping, other location state slots). Both are client-only; they throw
when called on the server.

Neither dispatches an event, so components reading via `useLocationState`
will NOT re-render until the next navigation/popstate. Pair with `.read()`
(or a fresh mount via back/forward/reload) instead.

```tsx
"use client";
import { ProductState } from "./state";

// Persisted across hard refresh and back/forward of this entry.
ProductState.write({ name: "Widget", price: 9.99 });

// Read later (or on next mount).
const current = ProductState.read();

// Manually clear the slot. Idempotent if it isn't set.
ProductState.delete();
```

| Method      | Updates `history.state` | Fires `useLocationState` rerender | SSR behavior        |
| ----------- | ----------------------- | --------------------------------- | ------------------- |
| `.read()`   | no                      | n/a (returns snapshot)            | returns `undefined` |
| `.write()`  | yes (replace this slot) | no                                | throws              |
| `.delete()` | yes (remove this slot)  | no                                | throws              |

## Cache Control

### invalidateClientCache()

Force the client's caches to miss after a mutation the router can't see (a REST
call, a WebSocket push, a login). It is a plain function, not a hook, so it works
from module-level callbacks too. Imported from the root entry `@rangojs/router`,
it is selected by export conditions: in a client component it marks the caches
stale immediately; from a handler/server component it writes a rotated
`Set-Cookie` for the responding client.

```tsx
"use client";
import { invalidateClientCache } from "@rangojs/router";

function SaveButton() {
  const handleSave = async () => {
    await fetch("/api/data", {
      method: "POST",
      body: JSON.stringify(data),
    });

    // Invalidate the client's caches after the mutation
    invalidateClientCache();
  };

  return <button onClick={handleSave}>Save</button>;
}
```

A module-level subscription works the same way (no component needed):

```ts
import { invalidateClientCache } from "@rangojs/router";

socket.on("catalog-updated", () => invalidateClientCache());
```

**Use cases**: REST API mutations, WebSocket updates, non-RSC data changes.

## Outlet Components

### Outlet / ParallelOutlet

Render child content in layouts:

```tsx
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function DashboardLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>{children ?? <Outlet />}</main>
      <ParallelOutlet name="@notifications" />
    </div>
  );
}
```

### useOutlet()

Access outlet content programmatically:

```tsx
"use client";
import { useOutlet } from "@rangojs/router/client";

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

### useParams()

Access route params from the current URL:

```tsx
"use client";
import { useParams } from "@rangojs/router/client";

// Route: /product/:productId
function ProductPage() {
  const params = useParams();
  // { productId: "123" }

  return <h1>Product {params.productId}</h1>;
}

// Annotate the expected shape via a generic
function ProductPageTyped() {
  const { productId } = useParams<{ productId: string }>();
  return <h1>Product {productId}</h1>;
}

// With selector for performance (re-renders only when selected value changes)
function ProductId() {
  const productId = useParams((p) => p.productId);
  return <span>ID: {productId}</span>;
}
```

Returns merged params from all matched route segments as a `Readonly<T>` map. Updates on navigation commit (not during pending navigation).

### usePathname()

Access the current URL pathname:

```tsx
"use client";
import { usePathname } from "@rangojs/router/client";

function CurrentPage() {
  const pathname = usePathname();
  // "/product/123" (no search params)

  return <span>Current path: {pathname}</span>;
}
```

Returns the pathname string without search params or hash. Updates on navigation commit.

### useSearchParams()

Access the current URL search params:

```tsx
"use client";
import { useSearchParams } from "@rangojs/router/client";

function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q"); // "react"
  const page = searchParams.get("page"); // "2"

  return (
    <div>
      Searching for: {query}, page {page}
    </div>
  );
}
```

Returns a `ReadonlyURLSearchParams` (URLSearchParams without mutation methods). During SSR, returns empty params and syncs from the browser URL on mount.

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

### useReverse(routes)

Mount-aware local reverse for client components. Import the generated `routes` map from a `urls()` module's `.gen.ts` and call `reverse("name", params?)` — the leading dot is optional. Auto-fills params from `useParams()`; explicit params override.

> Per-module `*.gen.ts` files are **CLI opt-in and not Vite-watched** — run `rango generate <urls-file>` (or wire it into `predev`) and re-run it whenever the module's routes change. See `/links` for the full generated-file setup and exposure-boundary rules.

```tsx
"use client";
import { Link, useReverse } from "@rangojs/router/client";
import { routes as blogRoutes } from "../urls/blog.gen.js";

function BlogNav() {
  const reverse = useReverse(blogRoutes);
  return (
    <nav>
      <Link to={reverse("index")}>Blog</Link>
      <Link to={reverse("post", { postId: "hello" })}>Post</Link>
    </nav>
  );
}
```

See `/links` for the full URL generation guide. `ctx.reverse()` is server-only; on the client, prefer `useReverse(routes)` for in-module names and pass URLs as props for cross-module ones.

## Hook Summary

| Hook                      | Purpose                                                        | Returns                                                            |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `useParams()`             | Route params                                                   | `Readonly<T>` (default `Record<string, string>`) or selected value |
| `usePathname()`           | Current pathname                                               | `string`                                                           |
| `useSearchParams()`       | URL search params                                              | `ReadonlyURLSearchParams`                                          |
| `useHref()`               | Mount-aware href                                               | `(path) => string`                                                 |
| `useMount()`              | Current include() mount path                                   | `string`                                                           |
| `useReverse()`            | Local reverse for imported routes                              | `(name, params?, search?) => string`                               |
| `useNavigation()`         | Reactive navigation state                                      | state, location, isStreaming                                       |
| `useRouter()`             | Stable router actions                                          | push, replace, refresh, prefetch, back, forward                    |
| `useSegments()`           | URL path & segment IDs                                         | path, segmentIds, location                                         |
| `useLinkStatus()`         | Link pending state                                             | { pending }                                                        |
| `useLoader()`             | Loader data (strict)                                           | data, isLoading, error, load, refetch                              |
| `useFetchLoader()`        | Loader with on-demand fetch                                    | data, load, isLoading, error, refetch                              |
| `useRefreshLoaders()`     | Refresh cross-loader group(s)                                  | `() => (groups: string \| string[]) => Promise<void>`              |
| `useHandle()`             | Accumulated handle data                                        | T (handle type)                                                    |
| `useAction()`             | Server action state                                            | state, error, result                                               |
| `useLocationState()`      | History state (persists or flash)                              | T \| undefined                                                     |
| `invalidateClientCache()` | Force client caches to miss (function, not a hook; root entry) | `void`                                                             |
