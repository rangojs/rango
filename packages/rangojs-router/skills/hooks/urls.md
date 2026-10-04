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

Returns merged params from all matched route segments as a `Readonly<T>` map (default `Record<string, string | undefined>` — absent optional params are omitted, so guard them). Updates on navigation commit, not during a pending navigation — except inside an optimistically rendered `clientUrls()` destination, where it reports that destination's params (see `/client-urls`).

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

Returns the pathname string without search params or hash. It is the pathname of the page on screen: it changes when a navigation's destination commits, Back/Forward included (see [When the URL hooks change](#when-the-url-hooks-change)).

### useSearchParams()

Read and write the current URL search params (React Router-style tuple):

```tsx
"use client";
import { useSearchParams } from "@rangojs/router/client";

function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q"); // "react"
  const page = searchParams.get("page"); // "2"

  return (
    <div>
      Searching for: {query}, page {page}
      <button onClick={() => setSearchParams({ q: query ?? "", page: "2" })}>
        Page 2
      </button>
    </div>
  );
}
```

The first element is a `ReadonlyURLSearchParams` (URLSearchParams without
mutation methods) from the committed location. During document SSR it
carries the live request's search (seeded into the SSR store), and the
browser's first render seeds from its own URL — hydration agrees by
construction. On ppr routes search is part of shell identity: the shell key
embeds the sorted search and the capture/resume renders seed that same
string, so static-part reads are legal and per-shell-correct. Edges: params
excluded by `cache.searchParams` are absent in shell renders, and
`.toString()` renders sorted order.

The setter REPLACES the whole search string (React Router semantics) and
navigates to the current pathname with the new params — a same-route
navigation, so loaders re-evaluate per their `revalidate()` contract and the
commit holds previous content. Accepted inits: a string, a `URLSearchParams`,
a record (numbers/booleans stringified, arrays append, `null`/`undefined`
skipped), or a function receiving a mutable copy of the current params for
merging:

```tsx
// Merge: keep everything, change one key
setSearchParams((prev) => {
  prev.set("page", "3");
  return prev;
});

// Filter UIs usually want replace + preserved scroll
setSearchParams({ category: "home" }, { replace: true, scroll: false });

// URL-only update: skip the server fetch for purely client-derived state
setSearchParams({ view: "grid" }, { revalidate: false });
```

Options: `replace` (default false — push), `scroll` (default true),
`revalidate` (default true; `false` skips the server fetch — legal because
the setter never changes the pathname).

### When the URL hooks change

`usePathname()`, `useSearchParams()` and `useParams()` describe the page on
screen. They change in the commit that shows a navigation's destination, not
when the navigation starts. That holds for Back/Forward as it does for a link
click or `router.push()`.

| Navigation                                        | The hooks change                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `<Link>`, `router.push()` / `router.replace()`    | when the destination commits                                               |
| Back/Forward, entry in the client's history cache | with the restored page, in one commit                                      |
| Back/Forward, entry fetched again                 | when the fetched page commits; until then the page being left is on screen |
| a Back/Forward whose fetch fails                  | with the error boundary: they report the entry the browser is on           |
| `router.push(url, { revalidate: false })`         | at once: nothing is fetched and the page stays                             |
| inside an optimistic `clientUrls()` destination   | at the click, for that branch only (see `/client-urls`)                    |

**The hooks can disagree with the address bar.** On Back/Forward the browser
changes the URL and `history.state` before it tells the router. When the
entry has to be fetched (it left the client's history cache, or the cache was
cleared), the page being left stays on screen for the wait and the hooks keep
reporting its URL, while `window.location` is already the destination's. That
is deliberate: an active-link highlight, a breadcrumb or a filter panel
derived from the hooks stays in step with the content next to it. For
anything you render, read the hooks, not `window.location`.

For pending UI during that wait read `useNavigation()` (see
[`./navigation.md`](./navigation.md)): `state === "loading"` and `pendingUrl`
(the entry being fetched) while the request is out, `isStreaming` for the
whole wait. A Back/Forward served from the history cache has no wait.

`setSearchParams((prev) => ...)` builds on the same location: called during a
pending Back/Forward, `prev` is the search of the page on screen.

One gap (issue #1046): a component that first mounts in the page being left
after the navigation's response has arrived, while React still holds the
destination behind a loader or a `transition()`, reads the destination's URL
and params from these hooks. Components that were already mounted are not
affected. It applies to a push and to Back/Forward alike.

### useHref()

Mount-aware href for client components inside `include()` scopes:

```tsx
"use client";
import { useHref, href, Link } from "@rangojs/router/client";

// Inside include("/shop", shopPatterns)
function ShopNav() {
  const localHref = useHref();

  return (
    <>
      {/* Local paths - auto-prefixed with /shop */}
      <Link to={localHref("/cart")}>Cart</Link>
      <Link to={localHref("/product/widget")}>Widget</Link>
      {/* Absolute path - not prefixed */}
      <Link to={href("/about")}>About</Link>
    </>
  );
}
```

Use `useHref()` for local navigation. Use the bare `href()` function for absolute paths. The function `useHref()` returns is referentially stable within a mount, so it is safe as a hook dependency or memoized prop.

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
