# URL Hooks

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
