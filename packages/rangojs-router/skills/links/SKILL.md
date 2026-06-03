---
name: links
description: URL generation with ctx.reverse (server default), href (client), useHref (mounted), useMount, useReverse, and scopedReverse
argument-hint: [ctx.reverse|href|useHref|useMount|useReverse|scopedReverse]
---

# Links & URL Generation

@rangojs/router provides different href APIs for server and client contexts.

**Default server API: `ctx.reverse()`.** Generate URLs from the handler context — it's typed, auto-fills mount params, and resolves local (`.name`) and absolute (`name.sub`) names.

**On the client, two patterns:**

1. **Receive URLs as props / loader data / action return.** The default. The server has the full route manifest and handler context — generate URLs there and hand strings to client components.
2. **`useReverse(routes)`.** Import a generated `routes` map from a `urls()` module's `.gen.ts` and call `reverse("name", params?)` (the leading dot is optional). Mount-aware via `useMount()`, auto-fills params from `useParams()`, fully typed from the imported map. Use this when a client component needs to generate URLs into a known module without round-tripping through the server.

`ctx.reverse()` itself is **server-only** — it depends on the full route manifest and handler context. Client components never import or call it.

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

`ctx.reverse()` is not available inside `"use client"` modules — there is no handler context in the browser bundle. For in-module names, prefer `useReverse(routes)` (see below) and import the relevant `urls/*.gen.js`. For cross-module URLs or one-off names, generate the URL on the server and hand it to the client component using one of these three patterns:

1. Pass as a prop from a server component:

```tsx
// server
function BlogPostPage(ctx: HandlerContext) {
  return <ShareButton url={ctx.reverse(".post", { slug: ctx.params.slug })} />;
}
```

```tsx
"use client";

export function ShareButton({ url }: { url: string }) {
  return (
    <button onClick={() => navigator.clipboard.writeText(url)}>Share</button>
  );
}
```

2. Return from a loader (attached to the route via the DSL):

```tsx
// server — loaders/nav.ts
export const NavLoader = createLoader((ctx) => ({
  home: ctx.reverse("home"),
  blog: ctx.reverse("blog.index"),
}));

// server — urls.tsx: attach the loader so useLoader has data in context
const urlpatterns = urls(({ path, loader }) => [
  path("/", HomePage, { name: "home" }, () => [loader(NavLoader)]),
]);
```

```tsx
"use client";

function Nav() {
  const { data } = useLoader(NavLoader);
  return <Link to={data.home}>Home</Link>;
}
```

`useLoader()` requires the loader to be attached to an active route. If you need on-demand fetching instead, use `useFetchLoader()`.

3. Return from a server action:

```tsx
"use server";

export async function getProductUrl(slug: string) {
  const ctx = getRequestContext();
  return ctx.reverse("product", { slug });
}
```

See `/server-actions` for the full action surface (`getRequestContext()` is the same context middleware and handlers use).

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

`href()` provides compile-time validation via the `Rango.Path` type. Paths are validated against registered route patterns using `PatternToPath`.

When wrapping `href()`, type the wrapper's path parameter as `Rango.Path` so it
keeps the same generated-route validation. `Rango.Path` is ambient — no import,
just like `Rango.Env` / `Rango.Vars`:

```typescript
import { href } from "@rangojs/router/client";

export const appHref = (path: Rango.Path): string => href(path);
```

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

## Client: useReverse(routes)

Hook that returns a typed local reverse function for a `routes` map imported from a generated `.gen.ts` next to a `urls()` module. The route map is the **exposure boundary** — `useReverse` only knows about names in that map, never the full app manifest.

> **Which map?** `useReverse` accepts any routes map. Prefer the per-module `routes` (e.g. `urls/blog.gen.ts`): it gives **mount-aware** local `.name` reverse (auto-prefixes the `include()` mount) and only that module's names enter the client bundle. You _can_ instead pass `router.named-routes.gen.ts` (`NamedRoutes`) for **global** names (`blog.post`; the leading dot is optional) — it is a plain importable map and works on the client (it is **not** server-only) — but its paths are **absolute** while `useReverse` mount-prefixes, so it is correct only at the root mount (under a non-root mount it double-prefixes), and importing it pulls every route name and pattern in the app into the client bundle (a small names-to-paths map — not components or loaders), versus the per-module map which exposes only one module's names. So the per-module map is preferred for in-module links; the named-routes map is the escape hatch for global names.

```tsx
"use client";
import { Link, useReverse } from "@rangojs/router/client";
import { routes as blogRoutes } from "../urls/blog.gen.js";

export function BlogNav() {
  const reverse = useReverse(blogRoutes);

  return (
    <nav>
      <Link to={reverse("index")}>Blog</Link>
      <Link to={reverse("post", { postId: "hello" })}>Post</Link>
    </nav>
  );
}
```

### How it resolves

1. Strips an optional leading `.` and looks up the name in the imported `routes` map.
2. Joins the local pattern with the surrounding `useMount()` value — the include's URL pattern.
3. Substitutes params: explicit params from the call, then auto-filled from `useParams()` for anything still unresolved (mount params like `:tenantId` flow in this way).
4. Appends a query string if a search object is passed and the route has a `search` schema.

### Mount-relativity

Patterns in the generated `routes` map are **mount-relative** — they're the patterns as defined inside the `urls()` module, _not_ the full app paths. Mount-joining happens at runtime via `useMount()`, so the same component works under any include:

```typescript
// urls/blog.tsx
export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:postId", BlogPost, { name: "post" }),
]);

// Generated urls/blog.gen.ts
// export const routes = { index: "/", post: "/:postId" } as const;

// urls.tsx — same module mounted twice
include("/news", blogPatterns, { name: "news" }),    // <BlogNav> renders /news, /news/hello
include("/journal", blogPatterns, { name: "diary" }), // <BlogNav> renders /journal, /journal/hello
```

The `/` pattern under a non-root mount collapses cleanly: under `/news`, `reverse(".index")` returns `/news` (no trailing slash), matching `ctx.reverse(".index")` on the server.

### Auto-filled params (mount params)

When the include itself carries `:params`, those are auto-filled from `useParams()` so the caller doesn't have to thread them through:

```typescript
// urls.tsx
include("/tenant/:tenantId", clientReversePatterns, { name: "tenant" });
```

```tsx
// At /tenant/acme/posts/p1, useParams() = { tenantId: "acme", postId: "p1" }
const reverse = useReverse(clientReverseRoutes);

reverse(".index"); // "/tenant/acme"
reverse(".post", { postId: "p2" }); // "/tenant/acme/posts/p2"   (tenantId auto-filled)
reverse(".post", { tenantId: "other", postId: "p2" }); // "/tenant/other/posts/p2" (explicit override)
```

Auto-fill follows soft navigation — when the matched route changes, `useReverse` re-renders with the new params.

### Search schemas

Routes declared with a `search` schema accept a typed search object as the third argument:

```typescript
// urls/blog.tsx
path("/search", SearchPage, {
  name: "search",
  search: { q: "string", page: "number?" },
}),

// Generated as: search: { path: "/search", search: { q: "string", page: "number?" } }
```

```tsx
const reverse = useReverse(blogRoutes);
reverse(".search", {}, { q: "hello world", page: 2 });
// "/news/search?q=hello%20world&page=2"
```

### Errors

- Unknown name: throws `Unknown route: ".not-a-route"`.
- Missing required param: throws `Missing param "postId" for route ".detail"`.

Both happen synchronously during `reverse()` — wrap calls in try/catch (or an ErrorBoundary if the throw happens during render) when you need to surface them as UI.

### The leading dot is optional

`reverse("post")` and `reverse(".post")` resolve **identically** — the leading dot is cosmetic. The map you import IS the scope, so there is no separate global namespace to disambiguate and the dot carries no meaning; it exists only as a readability convention and for parity with `ctx.reverse(".name")` on the server. To link into a different module, import that module's `routes`:

```tsx
import { routes as blogRoutes } from "../urls/blog.gen.js";
import { routes as shopRoutes } from "../urls/shop.gen.js";

function CrossNav() {
  const blog = useReverse(blogRoutes);
  const shop = useReverse(shopRoutes);
  return (
    <nav>
      <Link to={blog("index")}>Blog</Link>
      <Link to={shop("cart")}>Cart</Link>
    </nav>
  );
}
```

### Codegen

Each `urls()` module gets a sibling `.gen.ts` with the local route names and patterns, produced by `rango generate`:

```bash
pnpm exec rango generate src/urls/blog.tsx
# or generate everything under a directory:
pnpm exec rango generate src/urls --static
```

Don't edit the file by hand — re-run codegen when patterns change.

**Today the Vite plugin only regenerates the router-level `*.named-routes.gen.ts`.** Per-module `urls/*.gen.ts` files are emitted only by the CLI (or `writePerModuleRouteTypesForFile` programmatically). Commit the generated files and re-run `rango generate` whenever a `urls()` module's `path()`/`include()` shape changes. A common workflow is to wire it into a `predev` script:

```jsonc
// package.json
{
  "scripts": {
    "predev": "rango generate src",
    "dev": "vite",
  },
}
```

## When to use what

| Context          | API                                                | Resolves                                  | Use for                                                          |
| ---------------- | -------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Server handler   | `ctx.reverse("name")`                              | Named routes (local + absolute)           | **Default** server-side URL generation                           |
| Server handler   | `scopedReverse<T>(ctx.reverse)`                    | Same, with type safety                    | Type-safe server URLs                                            |
| Client component | `useReverse(routes)`                               | Local names from an imported `routes` map | Typed in-module URL generation without round-tripping the server |
| Client component | (URL passed as prop / loader data / action return) | Named routes                              | Cross-module URLs or one-off names you don't want to import      |
| Client component | `href("/path")`                                    | Absolute paths (static strings)           | Static navigation where no named-route lookup is needed          |
| Client component | `useHref()`                                        | Mount-prefixed paths                      | Local navigation inside `include()`                              |
| Client component | `useMount()`                                       | Raw mount path                            | Custom mount-aware logic                                         |

> `ctx.reverse()` is server-only. On the client, either generate URLs on the server and pass them in, or import the `routes` map and use `useReverse(routes)` for in-module names.

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
