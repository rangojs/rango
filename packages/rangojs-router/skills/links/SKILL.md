---
name: links
description: URL generation with ctx.href (server), href (client), useHref (mounted), useMount, and scopedHref
argument-hint: [href|useHref|useMount|scopedHref]
---

# Links & URL Generation

@rangojs/router provides different href APIs for server and client contexts.

## Server: ctx.href()

Available in route handlers via HandlerContext. Resolves named routes using the full route map.

```typescript
import { urls, scopedHref } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  layout(<ShopLayout />, () => [
    path("/", ShopIndex, { name: "index" }),
    path("/cart", CartPage, { name: "cart" }),
    path("/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```

### Resolution priority

1. **Path-based** (`/...`) - returned as-is
2. **Absolute name** (contains dot: `blog.post`) - global lookup
3. **Local name** (`cart`) - resolved relative to current route's namespace

```typescript
// Inside a handler within shopPatterns (mounted at /shop)
path("/product/:slug", (ctx) => {
  ctx.href("cart");                        // "/shop/cart" (local)
  ctx.href("product", { slug: "widget" }); // "/shop/product/widget" (local + params)
  ctx.href("blog.post", { slug: "hi" });   // "/blog/hi" (absolute)
  ctx.href("/about");                      // "/about" (path-based)

  return <ProductPage slug={ctx.params.slug} />;
}, { name: "product" })
```

### scopedHref() - type-safe ctx.href

Wraps `ctx.href` with local route type information for autocomplete and validation:

```typescript
import { scopedHref } from "@rangojs/router";

path("/product/:slug", (ctx) => {
  const href = scopedHref<typeof shopPatterns>(ctx.href);

  href("cart");                        // Type-safe local name
  href("product", { slug: "widget" }); // Type-safe with params
  href("blog.post");                   // Absolute names (dot notation) always allowed
  href("/about");                      // Path-based always allowed

  return <ProductPage slug={ctx.params.slug} />;
}, { name: "product" })
```

## Client: href()

Plain function for absolute path-based URLs. No hook needed - works anywhere.

```typescript
"use client";
import { href, Link } from "@rangojs/router/client";

function GlobalNav() {
  return (
    <nav>
      <Link to={href("/")}>Home</Link>
      <Link to={href("/about")}>About</Link>
      <Link to={href("/blog/hello")}>Post</Link>
    </nav>
  );
}
```

`href()` is an identity function at runtime but provides compile-time validation via `ValidPaths` type. Paths are validated against registered route patterns using `PatternToPath`.

## Client: useHref()

Hook that returns a mount-aware href function. Automatically prepends the `include()` mount prefix.

```typescript
"use client";
import { useHref, href, Link } from "@rangojs/router/client";

// Inside include("/shop", shopPatterns)
function ShopNav() {
  const href = useHref();

  return (
    <nav>
      <Link to={href("/")}>Shop Home</Link>        {/* "/shop/" */}
      <Link to={href("/cart")}>Cart</Link>          {/* "/shop/cart" */}
      <Link to={href("/product/widget")}>W</Link>   {/* "/shop/product/widget" */}
    </nav>
  );
}
```

Use `useHref()` for local navigation within a mounted module. Use the bare `href()` function for absolute paths outside the current mount.

## Client: useMount()

Returns the current `include()` mount path. Useful for building custom logic based on mount location.

```typescript
"use client";
import { useMount } from "@rangojs/router/client";

function MountInfo() {
  const mount = useMount(); // "/shop" inside include("/shop", ...)
                            // "/" at root level

  return <span>Mounted at: {mount}</span>;
}
```

`useMount()` reads from `MountContext`, which is automatically set by `include()` in the segment tree.

## When to use what

| Context | API | Resolves | Use for |
|---------|-----|----------|---------|
| Server handler | `ctx.href("name")` | Named routes (local + absolute) | Server-side URL generation |
| Server handler | `scopedHref<T>(ctx.href)` | Same, with type safety | Type-safe server URLs |
| Client component | `href("/path")` | Absolute paths | Global navigation |
| Client component | `useHref()` | Mount-prefixed paths | Local navigation inside `include()` |
| Client component | `useMount()` | Raw mount path | Custom mount-aware logic |

## Complete example: mounted module

```typescript
// urls/shop.tsx (server)
import { urls, scopedHref } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  layout((ctx) => {
    const href = scopedHref<typeof shopPatterns>(ctx.href);
    return <ShopLayout cartUrl={href("cart")} />;
  }, () => [
    path("/", ShopIndex, { name: "index" }),
    path("/cart", CartPage, { name: "cart" }),
    path("/product/:slug", ProductPage, { name: "product" }),
  ]),
]);

// urls.tsx (server)
export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/shop", shopPatterns),
]);
```

```tsx
// components/ShopNav.tsx (client)
"use client";
import { useHref, href, Link } from "@rangojs/router/client";

export function ShopNav() {
  const localHref = useHref();

  return (
    <nav>
      {/* Local paths - auto-prefixed with /shop */}
      <Link to={localHref("/cart")}>Cart</Link>
      <Link to={localHref("/product/widget")}>Widget</Link>

      {/* Absolute path - no prefix */}
      <Link to={href("/")}>Home</Link>
    </nav>
  );
}
```
