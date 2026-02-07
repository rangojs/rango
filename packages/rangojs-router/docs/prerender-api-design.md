# Pre-rendering API Design

## Overview

Pre-render route segments at build time. Layouts stay live (dynamic user data, A/B tests, cart). Only the route's own subtree (handler, child layouts, parallels, loaders) is pre-rendered.

## DSL API

`prerender()` is a `RouteUseItem` — only valid inside `path()`.

### Static routes

```ts
path("/about", <About />, {}, () => [
  prerender(),
])
```

### Dynamic routes with params

```ts
path("/blog/:slug", <BlogPost />, {}, () => [
  loader(BlogLoader),
  prerender(async () => [
    { slug: "hello-world" },
    { slug: "getting-started" },
  ]),
])
```

The params function signature is type-safe — inferred from the path pattern:

```ts
// /products/:category/:id requires { category: string, id: string }[]
path("/products/:category/:id", <Product />, {}, () => [
  loader(ProductLoader),
  prerender(async () => {
    const products = await db.query("SELECT category, id FROM products");
    return products; // TypeScript enforces { category: string, id: string }[]
  }),
])
```

### With child layouts and parallels

Everything inside the path is pre-rendered as a unit:

```ts
path("/blog/:slug", <BlogPost />, {}, () => [
  loader(BlogLoader),
  layout(<PostLayout />, () => [
    loader(PostMetaLoader),
  ]),
  parallel({
    "@sidebar": <RelatedPosts />,
    "@comments": <Comments />,
  }, () => [
    loader(RelatedPostsLoader),
  ]),
  prerender(async () => getSlugs()),
])
```

Pre-rendered segments for `/blog/hello-world`:
```
/blog/:slug route     (L0L0R0)     — PRE-RENDERED
  PostLayout           (L0L0R0L0)   — PRE-RENDERED
  @sidebar parallel    (L0L0R0.@s)  — PRE-RENDERED
  @comments parallel   (L0L0R0.@c)  — PRE-RENDERED
```

Parent layouts stay live:
```
Root layout            (L0)         — LIVE (user session, cart)
Blog layout            (L0L0)       — LIVE (dynamic banners, A/B)
```

### Revalidation as opt-out

`revalidate()` already exists in the DSL. When paired with `prerender()`, it acts as a runtime opt-out — if revalidate returns `true`, render live instead of serving pre-rendered:

```ts
path("/blog/:slug", <BlogPost />, {}, () => [
  loader(BlogLoader),
  prerender(async () => getSlugs()),
  revalidate(({ actionId }) => actionId?.includes("Blog") ?? false),
])
```

Flow:
1. Build: pre-render all segments for each slug
2. Runtime request: check pre-rendered cache for these params
3. Check `revalidate()` — if returns `true`, render live (update cache)
4. If not revalidated, serve pre-rendered segments

## Function Signature

```ts
// Static route — no params needed
function prerender(): PrerenderItem;

// Dynamic route — params matching the path pattern
function prerender<TParams>(
  getParams: () => Promise<TParams[]> | TParams[]
): PrerenderItem;
```

`TParams` is inferred from the parent `path()` pattern via `ExtractParams<TPattern>`.

## Segment Scope

`prerender()` applies to the route's entire subtree — all segments owned by the `path()`:

- The route handler segment itself
- Child layouts nested under this route
- Parallel slots under this route
- All loaders in these segments

It does NOT apply to:
- Parent layouts (they stay live)
- Sibling routes
- Anything outside this `path()` definition

## Build Pipeline

The existing build pipeline already:
1. Runs all route patterns via `RSCRouterContext` (`generate-manifest.ts`)
2. Captures route names, patterns, ancestry, constraints
3. Builds a trie for O(path_length) matching (`route-trie.ts`)
4. Writes static files to `dist/static/`

Pre-rendering extends step 1-4:

### Step 5: Discover pre-rendered routes

During manifest generation, collect routes that have `prerender()` items.
For each, resolve the params function to get the list of param sets.

### Step 6: Run loaders and render segments

For each pre-rendered route + param combination:
1. Build a synthetic request context (no real request — public data only)
2. Execute the route's loaders with those params
3. Render the route's segments (handler, child layouts, parallels) to RSC Flight payload
4. Store the Flight payload keyed by route name + params

### Step 7: Write to manifest

Add pre-rendered Flight payloads to the build output:
```
dist/static/__<hash>/
  routes.json          (existing — route manifest)
  prefixes.json        (existing — prefix tree)
  prerender/
    blog--hello-world.flight    (Flight payload for /blog/hello-world)
    blog--getting-started.flight
    products--shoes--nike-1.flight
    ...
```

### Step 8: Extend trie with prerender metadata

Add a `pr` flag to `TrieLeaf` for pre-rendered routes:
```ts
interface TrieLeaf {
  n: string;       // route name
  sp: string;      // static prefix
  a: string[];     // ancestry
  pr?: true;       // pre-rendered flag
  // ...existing fields
}
```

## Runtime Resolution

When the server matches a request to a pre-rendered route:

1. Trie match finds the route, sees `pr` flag
2. Derive cache key from route name + matched params
3. Look up pre-rendered Flight payload
4. Check `revalidate()` — if returns `true`, skip pre-rendered, render live
5. If pre-rendered payload exists and not revalidated:
   - Render parent layouts live (they have fresh user data)
   - Splice pre-rendered segments into the segment tree
   - Stream the assembled response
6. If no pre-rendered payload (new params after build):
   - Render live as normal (fallback to SSR)
   - Optionally cache the result for next request

## Constraints

### Loaders must be request-independent

Pre-rendered loaders run at build time with no request context. A loader that reads
`ctx.req.headers` or cookies will receive synthetic/empty values. This is by design —
pre-rendered content is public.

If a route needs request-dependent data, don't use `prerender()`.

### Handle data is frozen

Handle values (e.g., breadcrumbs) pushed during pre-rendering are baked in.
This is fine for static handle data like breadcrumbs but worth noting.

### Build time scales with params

10,000 blog posts = 10,000 loader + render executions at build time.
The build step should support concurrency controls.

## Fallback Behavior

For dynamic routes, a request may arrive with params not in the pre-rendered set
(e.g., a new blog post published after build). Behavior:

- Render live as normal (SSR fallback)
- No 404 — pre-rendering is an optimization, not a restriction
- The live-rendered result can be cached by `cache()` if configured

## Interaction with Existing DSL

| DSL item       | Interaction with `prerender()`                          |
|----------------|--------------------------------------------------------|
| `loader()`     | Loaders are executed at build time during pre-render    |
| `revalidate()` | Acts as runtime opt-out from pre-rendered cache         |
| `cache()`      | Orthogonal — cache handles runtime caching, prerender handles build-time |
| `layout()`     | Child layouts are pre-rendered, parent layouts are not  |
| `parallel()`   | Parallel slots are pre-rendered as part of the subtree  |
| `middleware()`  | Skipped during pre-render (no request to middleware against) |
| `loading()`    | Not relevant — pre-rendered segments don't suspend      |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered)  |
