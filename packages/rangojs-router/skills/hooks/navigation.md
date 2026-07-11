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
