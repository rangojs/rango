# Pre-rendering API Design

## Overview

Pre-render route segments at build time. Layouts stay live (dynamic user data, A/B tests, cart). Only the route's own subtree (handler, child layouts, parallels, loaders) is pre-rendered.

Pre-rendering is an optimization, not a restriction. If a pre-rendered version is not found for the matched params, the route renders live as normal.

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

### Controlling the pre-render boundary

The `B` segment boundary is exactly what's inside the `path()` that has
`prerender()`. The developer controls what gets pre-rendered by placing
content inside or outside the path:

```ts
// Option A: parallel INSIDE the path — pre-rendered with the route
path("/blog/:id", <Blog />, {}, () => [
  layout(<BlogLayout />, () => [
    parallel({ "@recent": <RecentBlogs /> }),  // inside B segment
  ]),
  prerender(async () => getIds()),
])

// Option B: parallel OUTSIDE in parent layout — live, cache() available
layout(<BlogLayout />, () => [
  parallel({ "@recent": <RecentBlogs /> }, () => [
    cache({ ttl: 300 }),  // normal runtime cache, not pre-rendered
  ]),
  path("/blog/:id", <Blog />, {}, () => [
    prerender(async () => getIds()),  // only the route handler
  ]),
])
```

In Option A, `@recent` is part of the `B` segment and gets pre-rendered
at build time with the blog post. In Option B, `@recent` lives in the
parent layout, renders live on every request, and can use `cache()` for
runtime caching independently.

This gives fine-grained control: attach content inside the path to
pre-render it, or keep it in a parent layout for live rendering with
optional runtime caching.

### Revalidation

`revalidate()` and `cache()` work on pre-rendered segments exactly like any
other segment. No special ISR concept — it's stale-while-revalidate as usual.
If `revalidate()` returns `true`, the pre-rendered version is skipped and the
route renders live.

```ts
path("/blog/:slug", <BlogPost />, {}, () => [
  loader(BlogLoader),
  prerender(async () => getSlugs()),
  revalidate(({ actionId }) => actionId?.includes("Blog") ?? false),
])
```

## Type Safety

### Params type inference

`prerender()` params must match the path pattern. The `path()` function carries
`TPattern` as a phantom type. The challenge is threading that type into
`prerender()` inside the `use()` callback.

The `use()` callback currently returns `RouteUseItem[]` — all items are untyped.
To make `prerender()` type-safe, the callback needs to receive the pattern type:

```ts
// Option A: generic use callback (preferred)
// path() passes TPattern to the use callback, which passes it to prerender()
path("/blog/:slug", <BlogPost />, {}, (use) => [
  use.prerender(async () => [
    { slug: "hello-world" },  // TS enforces { slug: string }
  ]),
])

// Option B: prerender() is standalone, validated via Vite plugin
// Less ergonomic but doesn't change the use() signature
path("/blog/:slug", <BlogPost />, {}, () => [
  prerender(async () => [
    { slug: "hello-world" },  // validated at build time, not compile time
  ]),
])
```

Option A gives compile-time safety. Option B keeps the existing DSL shape
but defers validation to the build step.

### Function signature

```ts
// Static route — no params needed
function prerender(): PrerenderItem;

// Dynamic route — params matching the path pattern
function prerender<TParams>(
  getParams: () => Promise<TParams[]> | TParams[]
): PrerenderItem;
```

`TParams` is inferred from the parent `path()` pattern via `ExtractParams<TPattern>`.

## Build Segment: `B` type

`prerender()` introduces a new segment type: `B` (build). The `B` segment wraps
the route's subtree, similar to how child layouts wrap routes. It is the atomic
unit of pre-rendering — the entire `B` segment is served from cache or rendered
live, never partially.

### Segment tree

```
L0 (root layout)              — LIVE (user session, cart)
  L0L0 (blog layout)          — LIVE (dynamic banners, A/B)
    L0L0B0 (build boundary)   — pre-render unit
      L0L0B0R0 (route)
      L0L0B0R0L0 (post layout)
      L0L0B0R0.@sidebar
      L0L0B0R0.@comments
```

Parent layouts above `B` are always live. Everything inside `B` is pre-rendered
as one unit at build time.

### Runtime behavior

When the segment resolver encounters a `B` segment:

1. Derive cache key from router id + route name + param hash
2. Look up pre-rendered Flight payload
3. If found and `revalidate()` returns `false` — serve entire `B` subtree from cache
4. If not found or revalidated — render live (same as if `prerender()` wasn't there)
5. `cache()` works on the `B` segment like any other — stale-while-revalidate for ISR

The `B` segment is transparent to the client. The client receives segments
and assembles them into the React tree as usual — it doesn't know or care
whether segments were pre-rendered or live-rendered.

## Storage Layout

Pre-rendered Flight payloads are stored in the build output, keyed by
`{router-id}/{route-name}/{param-hash}`:

```
dist/static/__<hash>/
  routes.json          (existing — route manifest)
  prefixes.json        (existing — prefix tree)
  prerender/
    main/                              # router id (mount index)
      blog.post/                       # route name
        a1b2c3d4.flight                # hash of { slug: "hello-world" }
        e5f6a7b8.flight                # hash of { slug: "getting-started" }
      products.detail/                 # route name
        c9d0e1f2.flight                # hash of { category: "shoes", id: "nike-1" }
      about/                           # static route (no params)
        _.flight                       # single entry, no param hash needed
    admin/                             # second router
      admin.dashboard/
        _.flight
```

Each router has its own namespace. The param hash is a deterministic hash of
the sorted param key-value pairs so the runtime can reconstruct the lookup key
from matched params without an index file.

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
3. Render the route's `B` segment subtree (handler, child layouts, parallels) to RSC Flight payload
4. Store the Flight payload keyed by router id + route name + param hash

### Step 7: Write to build output

Write pre-rendered Flight payloads to `dist/static/__<hash>/prerender/`
following the storage layout above.

### Step 8: Extend trie with prerender metadata

Add a `pr` flag to `TrieLeaf` for pre-rendered routes:
```ts
interface TrieLeaf {
  n: string;       // route name
  sp: string;      // static prefix
  a: string[];     // ancestry
  pr?: true;       // has pre-rendered B segment
  // ...existing fields
}
```

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
Without controls this can exhaust system memory or overwhelm third-party
APIs (CMS, database, CDN).

## Vite Plugin Configuration

Build-time pre-rendering is controlled via the Vite plugin to manage
system resources and API pressure:

```ts
// vite.config.ts
rango({
  prerender: {
    // Max concurrent render operations. Each render executes loaders
    // and renders the B segment subtree. Low values protect against
    // memory exhaustion and API rate limits.
    // Default: 5
    concurrency: 5,

    // Per-render timeout in ms. Kills renders that hang on slow APIs.
    // Default: 30000
    timeout: 30_000,

    // What to do when a single render fails (loader throws, timeout, etc.)
    // "skip": log warning, continue with remaining params (partial pre-render)
    // "fail": abort the entire build
    // Default: "skip"
    onError: "skip",
  },
})
```

These controls are critical for production builds with large param sets.
A blog with 10,000 posts hitting a CMS API at `concurrency: 50` could
trigger rate limiting. The defaults are conservative — users can tune
up based on their infrastructure.

## Fallback Behavior

For dynamic routes, a request may arrive with params not in the pre-rendered set
(e.g., a new blog post published after build). Behavior:

- Render live as normal (SSR fallback)
- No 404 — pre-rendering is an optimization, not a restriction
- The live-rendered result can be cached by `cache()` if configured
- The `B` segment is still created at runtime, it just isn't pre-populated

## Interaction with Existing DSL

| DSL item       | Interaction with `prerender()`                          |
|----------------|--------------------------------------------------------|
| `loader()`     | Loaders are executed at build time during pre-render    |
| `revalidate()` | Returns `true` to skip pre-rendered, render live        |
| `cache()`      | Works on `B` segment like any other — enables ISR via stale-while-revalidate |
| `layout()`     | Child layouts inside `B` are pre-rendered, parent layouts are live |
| `parallel()`   | Parallel slots inside `B` are pre-rendered              |
| `middleware()`  | Skipped during pre-render (no request to middleware against) |
| `loading()`    | Not relevant — pre-rendered segments don't suspend      |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered)  |
