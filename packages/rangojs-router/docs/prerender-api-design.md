# Pre-rendering API Design

## Overview

Pre-render route segments at build time. The primary use case is content that
exists locally at build time but not on the runtime server — markdown files,
config, static text, documentation. You don't want to bundle and ship all that
content to the server just to render it on every request. Pre-rendering
processes it at build time and stores the Flight payload to serve at runtime
without needing the source files on the server.

Parent layouts stay live (dynamic user data, A/B tests, cart) while only the
route's own subtree (handler, child layouts, parallels, loaders) is pre-rendered.

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

### Restrictions

`prerender()` is incompatible with `revalidate()` on the same path.
Pre-rendered routes are static — they don't re-render at runtime.
Using both produces a build-time warning.

Server actions on pre-rendered pages work but are handled client-side
only. Actions do not cause the `B` segment to re-render — the
pre-rendered content stays as-is.

## Handler Elimination

The route handler and its loaders run at build time only. The Vite plugin
strips them from the server bundle after pre-rendering. This is critical
for the primary use case: a handler that reads markdown via `node:fs`
cannot ship to Cloudflare Workers. Pre-rendering processes the content
at build time and eliminates the handler from the runtime bundle.

```ts
// This handler uses node:fs — cannot run on Cloudflare Workers
const BlogPost = async (ctx) => {
  const md = await fs.readFile(`content/${ctx.params.slug}.md`, "utf-8");
  return <Article content={md} />;
};

path("/blog/:slug", <BlogPost />, {}, () => [
  prerender(async () => {
    const files = await glob("content/blog/*.md");
    return files.map(f => ({ slug: basename(f, ".md") }));
  }),
])
// After build: BlogPost and node:fs are NOT in the server bundle.
// Only the pre-rendered Flight payloads exist at runtime.
```

If a request arrives for params not in the pre-rendered set, the `B`
segment has no handler to fall back to. The behavior depends on
configuration (404 or a generic fallback page).

## Dev Mode

In dev mode, `prerender()` is treated as on-demand rendering. The route
renders live on first request — same as normal SSR. Since `prerender()`
provides the params function, the dev server knows all valid URLs and
can generate them on-demand. No build step needed in development.

A dev-mode warning is emitted to remind that pre-rendering only happens
during production builds.

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
unit of pre-rendering — the entire `B` segment is served from cache, never
partially.

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

### Tree structure stability

The `B` segment is always present in the tree, regardless of whether pre-rendered
data exists. The segment tree has the same shape in all render paths:

```
Pre-rendered:   L0 → L0L0 → L0L0B0 → L0L0B0R0  (B served from cache)
Dev mode:       L0 → L0L0 → L0L0B0 → L0L0B0R0  (B rendered on-demand)
Navigation:     L0 → L0L0 → L0L0B0 → L0L0B0R0  (partial update)
Action:         L0 → L0L0 → L0L0B0 → L0L0B0R0  (same tree)
```

No conditional tree depth. React never sees a structural difference.

### `B` is server-only, renders nothing on the client

The `B` segment has no component and renders no DOM. It is a server-side
resolution boundary only — a transparent pass-through. The client never
sees `B`, never hydrates it, has no knowledge of it. The client receives
the inner segments (route, layouts, parallels) directly.

### Runtime behavior

When the segment resolver encounters a `B` segment:

1. Derive cache key from router id + route name + param hash
2. Look up pre-rendered Flight payload
3. If found — serve entire `B` subtree from cache
4. If not found — no handler available (eliminated from bundle), return fallback

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

### Step 7: Eliminate handlers from bundle

The Vite plugin marks pre-rendered route handlers and their loaders as
build-time only. They are tree-shaken from the server bundle. This
prevents bundling node-specific APIs (node:fs, node:path) into the
runtime server.

### Step 8: Write to build output

Write pre-rendered Flight payloads to `dist/static/__<hash>/prerender/`
following the storage layout above.

### Step 9: Extend trie with prerender metadata

Add a `pr` flag to `TrieLeaf` for pre-rendered routes:
```ts
interface TrieLeaf {
  n: string;       // route name
  sp: string;      // static prefix
  a: string[];     // ancestry
  pr?: true;       // has pre-rendered B segment (handler eliminated)
  // ...existing fields
}
```

## Constraints

### Loaders must be request-independent

Pre-rendered loaders run at build time with no request context. A loader that reads
`ctx.req.headers` or cookies will receive synthetic/empty values. This is by design —
pre-rendered content is public.

If a route needs request-dependent data, don't use `prerender()`.

### No revalidate() with prerender()

`revalidate()` is incompatible with `prerender()`. The handler is eliminated
from the bundle — there is nothing to re-render at runtime. Using both
produces a build-time warning.

### Handle data is frozen

Handle values (e.g., breadcrumbs) pushed during pre-rendering are baked in.
This is fine for static handle data like breadcrumbs but worth noting.

### Server actions are client-side only

Server actions on pre-rendered pages work but do not cause the `B` segment
to re-render. The pre-rendered content stays as-is. Action results are
handled client-side.

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
    // and renders segments. Low values protect against memory exhaustion
    // and API rate limits.
    // Default: 5
    concurrency: 5,

    // Per-render timeout in ms. Kills renders that hang on slow APIs.
    // Default: 30000
    timeout: 30_000,
  },
})
```

Error handling during pre-render uses the router's existing `onError`
handler. A failed pre-render for a specific param set is treated like
a runtime render error — the route simply won't have a pre-rendered
version for those params.

## Interaction with Existing DSL

| DSL item       | Interaction with `prerender()`                          |
|----------------|--------------------------------------------------------|
| `loader()`     | Loaders executed at build time, eliminated from bundle  |
| `revalidate()` | Not allowed with `prerender()` — build-time warning     |
| `cache()`      | Orthogonal — use on parent layouts, not on pre-rendered routes |
| `layout()`     | Child layouts inside `B` are pre-rendered, parent layouts are live |
| `parallel()`   | Parallel slots inside `B` are pre-rendered              |
| `middleware()`  | Skipped during pre-render (no request to middleware against) |
| `loading()`    | Not relevant — pre-rendered segments don't suspend      |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered)  |

## Open Questions

- **Fallback for unknown params**: handler is eliminated — what happens for
  params not in the pre-rendered set? 404? Generic fallback component?
- **Incremental builds**: add one blog post — re-render all 10,000 or diff
  against existing output and render only new/changed?
- **Client navigation to pre-rendered routes**: partial update system needs
  to serve pre-rendered Flight payload for `B` segments during RSC fetch.
