---
name: links
description: URL generation with ctx.reverse (server default), href (client), useHref (mounted), useMount, and scopedReverse
argument-hint: [ctx.reverse|href|useHref|useMount|scopedReverse]
---

# Links & URL Generation

@rangojs/router provides different href APIs for server and client contexts.

**Default server API: `ctx.reverse()`.** Generate URLs from the handler context — it's typed, auto-fills mount params, and resolves local (`.name`) and absolute (`name.sub`) names.

**`reverse()` is server-only.** It depends on the route manifest and handler context, neither of which are available in the browser. Client components receive URLs as props, loader data, or server-action return values — they never call `reverse` directly.

## Server: ctx.reverse()

Available in route handlers via HandlerContext. Resolves named routes using the full route map. This is the default way to generate URLs on the server.

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

### Resolution rules

- **`.name`** — local route, resolved within the current `include()` scope
- **`name`** — global route, from the named-routes definition

```typescript
// Inside a handler within shopPatterns (mounted at /shop)
path("/product/:slug", (ctx) => {
  ctx.reverse(".cart");                        // "/shop/cart" (local)
  ctx.reverse(".product", { slug: "widget" }); // "/shop/product/widget" (local + params)
  ctx.reverse("blog.post", { slug: "hi" });    // "/blog/hi" (global)

  return <ProductPage slug={ctx.params.slug} />;
}, { name: "product" })
```

### Local names (dot-prefixed)

Prefix a name with `.` to resolve it within the current `include()` scope. The route is looked up using the include's mount namespace.

```typescript
// urls/magazine.tsx — mounted at include("/magazine", magazinePatterns, { name: "magazine" })
(ctx) => {
  ctx.reverse(".article", { slug: "design" }); // "/magazine/design"
  ctx.reverse(".author.posts", { authorSlug: "alice" }); // "/magazine/author/alice/posts"
  ctx.reverse(".index"); // "/magazine"
  ctx.reverse(".blog.index"); // THROWS — no magazine.blog.index
};
```

### Auto-fill of mount params

When routes are mounted via a parameterized `include()`, `ctx.reverse()` automatically fills mount params from `ctx.params`. Inner handlers don't need to pass params that are already known from the current URL match. Explicitly passed params override auto-filled values.

```typescript
// urls/tenant.tsx — mounted at include("/tenant/:tenantId", tenantPatterns, { name: "tenant" })
export const tenantPatterns = urls(({ path }) => [
  path("/", (ctx) => {
    // tenantId is auto-filled from ctx.params — no need to pass it
    ctx.reverse(".settings");                              // "/tenant/acme/settings" (when visiting /tenant/acme)
    ctx.reverse(".user", { userId: "u1" });                // "/tenant/acme/users/u1" (tenantId auto-filled, userId explicit)
    ctx.reverse(".settings", { tenantId: "other" });       // "/tenant/other/settings" (explicit override)

    // Global names also get auto-filled params
    ctx.reverse("tenant.settings");                        // "/tenant/acme/settings"
    return <TenantIndex />;
  }, { name: "index" }),
  path("/settings", SettingsPage, { name: "settings" }),
  path("/users/:userId", UserPage, { name: "user" }),
]);
```

Auto-fill uses `{ ...ctx.params, ...hrefParams }` — current request params are defaults, explicit params win. Params not needed by the target route are silently ignored.

### Global names (unprefixed)

Unprefixed names resolve against the full named-routes map (the generated `router.named-routes.gen.ts`).

```typescript
(ctx) => {
  ctx.reverse("magazine.index"); // "/magazine"
  ctx.reverse("blog.post", { slug: "hello" }); // "/blog/hello"
};
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

Wraps `ctx.reverse` with local route type information for autocomplete and validation. Runtime behavior is identical to `ctx.reverse` — `scopedReverse` is a type-only cast. The same dot-prefix rule applies: local names use `.name`, global names use `name.sub`.

```typescript
import { scopedReverse } from "@rangojs/router";

path("/product/:slug", (ctx) => {
  const reverse = scopedReverse<typeof shopPatterns>(ctx.reverse);

  reverse(".cart");                        // Local name (dot-prefixed) — resolves in include scope
  reverse(".product", { slug: "widget" }); // Local name with params
  reverse("blog.post", { slug: "hi" });    // Global name (dotted) — full route map

  return <ProductPage slug={ctx.params.slug} />;
}, { name: "product" })
```

`reverse()` does not accept raw path strings (`"/about"`). For static paths in client components, use `href("/about")`; on the server, look up the route by name.

## Client components: receive URLs as props

`reverse()` is not available inside `"use client"` modules — there is no handler context and no route manifest in the browser bundle. Generate the URL on the server and hand it to the client component.

Three patterns, in order of preference:

```tsx
// 1. Pass as a prop from a server component
// server
function BlogPostPage(ctx: HandlerContext) {
  return <ShareButton url={ctx.reverse(".post", { slug: ctx.params.slug })} />;
}

// client
("use client");
export function ShareButton({ url }: { url: string }) {
  return (
    <button onClick={() => navigator.clipboard.writeText(url)}>Share</button>
  );
}
```

```tsx
// 2. Return from a loader (attached to the route via the DSL)
// server — loaders/nav.ts
export const NavLoader = createLoader((ctx) => ({
  home: ctx.reverse("home"),
  blog: ctx.reverse("blog.index"),
}));

// server — urls.tsx: attach the loader so useLoader has data in context
const urlpatterns = urls(({ path, loader }) => [
  path("/", HomePage, { name: "home" }, () => [loader(NavLoader)]),
]);

// client
("use client");
function Nav() {
  const { data } = useLoader(NavLoader);
  return <Link to={data.home}>Home</Link>;
}
```

`useLoader()` requires the loader to be attached to an active route. If you need on-demand fetching instead, use `useFetchLoader()`.

```tsx
// 3. Return from a server action
// server
"use server";
export async function getProductUrl(slug: string) {
  const ctx = getRequestContext();
  return ctx.reverse("product", { slug });
}
```

For static path strings (not named routes), client components can use `href()` — see below.

## Client: href()

Plain function for absolute path-based URLs. No hook needed - works anywhere in client components. `href()` validates paths at compile time, but does **not** resolve named routes — for named routes, use one of the patterns above.

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

`href()` provides compile-time validation via `ValidPaths` type. Paths are validated against registered route patterns using `PatternToPath`.

`href()` is a raw path helper — it is **not** basename-aware. It returns the path as-is (or with the include mount prefix via `useHref()`). For basename-aware navigation, use `Link`, `useRouter().push()`, or `reverse()`, which auto-prefix root-relative paths with the router's basename.

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

| Context          | API                                                | Resolves                        | Use for                                                          |
| ---------------- | -------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| Server handler   | `ctx.reverse("name")`                              | Named routes (local + absolute) | **Default** server-side URL generation                           |
| Server handler   | `scopedReverse<T>(ctx.reverse)`                    | Same, with type safety          | Type-safe server URLs                                            |
| Client component | (URL passed as prop / loader data / action return) | Named routes                    | Any URL derived from a named route — generate on server, pass in |
| Client component | `href("/path")`                                    | Absolute paths (static strings) | Static navigation where no named-route lookup is needed          |
| Client component | `useHref()`                                        | Mount-prefixed paths            | Local navigation inside `include()`                              |
| Client component | `useMount()`                                       | Raw mount path                  | Custom mount-aware logic                                         |

> `reverse()` is server-only. Client components never import or call it — they receive the already-resolved string.

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
