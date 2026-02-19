---
name: links
description: URL generation with ctx.reverse (server), href (client), useHref (mounted), useMount, and scopedReverse
argument-hint: [href|useHref|useMount|scopedReverse]
---

# Links & URL Generation

@rangojs/router provides different href APIs for server and client contexts.

## Server: ctx.reverse()

Available in route handlers via HandlerContext. Resolves named routes using the full route map.

```typescript
import { urls, scopedReverse } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  layout(<ShopLayout />, () => [
    path("/", ShopIndex, { name: "index" }),
    path("/cart", CartPage, { name: "cart" }),
    path("/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```

### Resolution priority

1. **Path-based** (`/...`) — returned as-is
2. **Dot-prefixed** (`.author.posts`) — strictly local, never falls through to global
3. **Unprefixed** (`cart`, `author.posts`) — local first, then global fallback

```typescript
// Inside a handler within shopPatterns (mounted at /shop)
path("/product/:slug", (ctx) => {
  ctx.reverse("cart");                        // "/shop/cart" (local)
  ctx.reverse("product", { slug: "widget" }); // "/shop/product/widget" (local + params)
  ctx.reverse("blog.post", { slug: "hi" });   // "/blog/hi" (global fallback)
  ctx.reverse("/about");                      // "/about" (path-based)

  return <ProductPage slug={ctx.params.slug} />;
}, { name: "product" })
```

### Dot-prefixed local names

Prefix a name with `.` to guarantee it resolves within the current `include()` scope. Like `./` in file paths — if the name doesn't exist locally, it throws instead of falling back to global.

```typescript
// urls/magazine.tsx
export const magazinePatterns = urls(({ path, layout }) => [
  layout(<MagazineLayout />, () => [
    path("/", MagazineIndex, { name: "index" }),
    path("/:slug", MagazineArticle, { name: "article" }),
    path("/author/:authorSlug", MagazineAuthor, { name: "author" }),
    path("/author/:authorSlug/posts", MagazineAuthorPosts, { name: "author.posts" }),
  ]),
]);

// Inside MagazineAuthor handler (current route: magazine.author)
(ctx) => {
  ctx.reverse(".article", { slug: "design" });            // "/magazine/design" (strictly local)
  ctx.reverse(".author.posts", { authorSlug: "alice" });   // "/magazine/author/alice/posts" (strictly local)
  ctx.reverse(".blog.index");                              // THROWS — no magazine.blog.index

  // Without dot prefix — local first, then global fallback:
  ctx.reverse("author.posts", { authorSlug: "alice" });   // "/magazine/author/alice/posts" (local match)
  ctx.reverse("blog.index");                              // "/blog" (global fallback)
}
```

### reverse with search params

When a route has a `search` schema, pass a typed search object as the third argument:

```typescript
path("/search", (ctx) => {
  // Generates: /search?q=react&page=2
  const url = ctx.reverse("search", {}, { q: "react", page: 2 });
  return <Link to={url}>Search React</Link>;
}, { name: "search", search: { q: "string", page: "number?" } })
```

### scopedReverse() - type-safe ctx.reverse

Wraps `ctx.reverse` with local route type information for autocomplete and validation:

```typescript
import { scopedReverse } from "@rangojs/router";

path("/product/:slug", (ctx) => {
  const reverse = scopedReverse<typeof shopPatterns>(ctx.reverse);

  reverse("cart");                        // Type-safe local name
  reverse("product", { slug: "widget" }); // Type-safe with params
  reverse("blog.post");                   // Absolute names (dot notation) always allowed
  reverse("/about");                      // Path-based always allowed

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
| Server handler | `ctx.reverse("name")` | Named routes (local + absolute) | Server-side URL generation |
| Server handler | `scopedReverse<T>(ctx.reverse)` | Same, with type safety | Type-safe server URLs |
| Client component | `href("/path")` | Absolute paths | Global navigation |
| Client component | `useHref()` | Mount-prefixed paths | Local navigation inside `include()` |
| Client component | `useMount()` | Raw mount path | Custom mount-aware logic |

## Complete example: mounted module

```typescript
// urls/shop.tsx (server)
import { urls, scopedReverse } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  layout((ctx) => {
    const reverse = scopedReverse<typeof shopPatterns>(ctx.reverse);
    return <ShopLayout cartUrl={reverse("cart")} />;
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
