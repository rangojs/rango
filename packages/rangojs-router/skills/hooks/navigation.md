# Navigation Hooks

### useNavigation()

Track reactive navigation state (state-only, no actions):

```tsx
"use client";
import { useNavigation } from "@rangojs/router/client";

function NavIndicator() {
  const nav = useNavigation();

  // State properties
  nav.state; // 'idle' | 'loading'
  nav.isStreaming; // boolean — RSC data is still streaming
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

#### Pending UI, Back/Forward included

A link click, `router.push()` and a Back/Forward that has to fetch its entry
report a pending navigation the same way. While the page being left is still
on screen:

| What you want to show                          | Read                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| a request is out, nothing has arrived          | `state === "loading"`; `pendingUrl` is the URL being fetched                        |
| the page has not fully arrived yet             | `isStreaming`: true from the start of the request until the stream ends             |
| which page is on screen while the request runs | `location`, or `usePathname()` / `useSearchParams()` (see [`./urls.md`](./urls.md)) |

`state` and `pendingUrl` cover the network wait. Once the response has
arrived a loader may still be streaming, and React keeps the page being left
on screen where a navigation holds its content (a same-route change, a
`transition()` route); `isStreaming` covers that part too, so use it for a
progress indicator that should last until the new page is complete.

On Back/Forward the address bar changes at once, before any of this: during
the wait `window.location` is the entry being fetched, the same URL as
`pendingUrl`, and `location` is the page on screen. A Back/Forward served
from the client's history cache restores its page in one commit and reports
no pending state.

`location` moves when the response arrives. Where React then holds the page
being left, it is ahead of the screen for that last part of the wait, and so
is a URL hook in a component that first mounts then (issue #1046).

### useRouter()

Access stable router actions. The returned object never changes identity, so
components using it do not re-render on navigation. Call its methods from
event handlers or effects:

```tsx
"use client";
import { useRouter } from "@rangojs/router/client";

function NavigationControls() {
  const router = useRouter();

  return (
    <>
      <button onClick={() => router.push("/products")}>Products</button>
      <button onClick={() => router.replace("/login", { scroll: false })}>
        Log in
      </button>
      <button onClick={() => router.refresh()}>Reload data</button>
      <button onMouseEnter={() => router.prefetch("/dashboard")}>
        Dashboard
      </button>
      <button onClick={() => router.back()}>Back</button>
      <button onClick={() => router.forward()}>Forward</button>
    </>
  );
}
```

| Method                   | Behaviour                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `push(url, options?)`    | Navigate and add a history entry. Returns a promise.                                                            |
| `replace(url, options?)` | Navigate and replace the current history entry. Returns a promise.                                              |
| `refresh()`              | Re-fetch the current route's server data, keeping client state. Returns a promise.                              |
| `prefetch(url, opts?)`   | Prefetch a target. `{ key: ":source" }` scopes the entry to the source page (parity with `<Link prefetchKey>`). |
| `back()`                 | `history.back()`; on the first entry of the session it replaces to the app root instead of leaving the app.     |
| `forward()`              | `history.forward()`.                                                                                            |

`push` / `replace` options: `scroll` (`false` keeps the current scroll
position), `revalidate` (default `true`, see below), `transition` (`false`
skips the route's `transition()` for this navigation, see below), and `state`
(location state: `[MyState(value)]` for typed entries, or plain
structured-clone-safe data; see [`./state.md`](./state.md)).

Target resolution: a path starting with `/` is app-absolute and gets the
router `basename` prefixed. A relative path (`"cart"`, `"./cart"`) resolves
against the current `include()` mount, so `router.push("cart")` inside
`include("/shop", ...)` navigates to `/shop/cart`.

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

#### Skipping the transition

Pass `transition: false` to present one navigation without the route's
`transition()`: the commit is urgent (the `loading()` skeleton streams) and no
view transition runs, the same result as a `transition({ when })` predicate
returning `false`. No predicate is called. Back/forward, actions and
revalidation are unaffected.

```tsx
router.push("/photos/2", { transition: false });

<Link to="/photos/2" transition={false}>
  Next
</Link>;
```

Plain `<a>` tags can opt in via `data-transition="false"`. See
`/view-transitions` → "Conditional transitions".

### useSegments()

Access current URL path and matched route segments:

```tsx
"use client";
import { useSegments } from "@rangojs/router/client";

function Breadcrumbs() {
  const { path, segmentIds, location } = useSegments();

  // path: ["shop", "products", "123"] (split on "/", no leading slash on any element)
  // segmentIds: ["L0", "L0L1", "L0L1R0"] (layouts and routes only; opaque internal short-codes, not route names)
  // location: URL object

  return <nav>{path.join(" > ")}</nav>;
}

// With selector
const isShopRoute = useSegments((s) => s.path[0] === "shop");
```

### useLinkStatus()

Track pending state inside a Link component. `pending` is `true` while a
navigation to this link's `to` is in flight:

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
