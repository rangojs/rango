# Pre-rendering API Design

## Overview

Pre-render route segments at build time. The primary use case is content that
exists locally at build time but not on the runtime server — markdown files,
config, static text, documentation. You don't want to bundle and ship all that
content to the server just to render it on every request. Pre-rendering
processes it at build time and stores the Flight payload to serve at runtime
without needing the source files on the server.

Parent layouts stay live (dynamic user data, A/B tests, cart) while only the
route's own subtree (handler, child layouts, parallels) is pre-rendered.
Loaders are not affected — they run at request time as normal and are
bundled into the server build. Users should not use APIs in loaders that
won't exist on the target deployment.

## API: `createPrerenderHandler`

Follows the same pattern as `createLoader` and `createHandle`. The Vite plugin
detects `createPrerenderHandler()` exports via regex, injects `$$id`, and
generates stubs in non-RSC environments — identical to how `exposeLoaderId`
works today.

### Signature

```ts
interface PrerenderOptions {
  // Keep handler in server bundle for live fallback (default: false)
  // false: handler replaced with stub, node APIs excluded from bundle
  // true: handler stays in bundle, unknown params render live
  passthrough?: boolean;
}

// Static route — no params
function createPrerenderHandler<TParams>(
  handler: (ctx: BuildContext<TParams>) => ReactNode,
  options?: PrerenderOptions
): PrerenderHandlerDefinition<TParams>;

// Dynamic route — params first, handler second
function createPrerenderHandler<TParams>(
  getParams: () => Promise<TParams[]> | TParams[],
  handler: (ctx: BuildContext<TParams>) => ReactNode,
  options?: PrerenderOptions
): PrerenderHandlerDefinition<TParams>;
```

Params come first because they are the defining characteristic of a
pre-rendered handler — the first thing you want to see when reading the code.

### BuildContext

The handler receives a `BuildContext` that mimics the runtime handler context.
This allows handlers to be written in a familiar style while making it clear
they run at build time, not at request time.

```ts
interface BuildContext<TParams> {
  // Params extracted from the route pattern (populated from getParams)
  params: TParams;

  // Push handle data (frozen into pre-rendered output)
  use: <T>(handle: Handle<T>) => (data: T) => void;

  // Synthetic URL built from pattern + params (no real request)
  url: URL;
  pathname: string;

  // NOT available (build time has no request):
  // req, headers, cookies, env — accessing these throws with a clear error
}
```

`BuildContext` is intentionally a subset of the runtime `HandlerContext`.
Properties that depend on a real HTTP request (`req`, `headers`, `cookies`,
`env`) are not available and throw descriptive errors if accessed, guiding
the developer to move request-dependent logic elsewhere.

Loaders are not available in `BuildContext`. They run at request time and
are not part of the pre-render pipeline. Data needed at build time should
be fetched directly in the handler (e.g., `fs.readFile`, inline queries).

### Examples

```ts
// blog-post.tsx
import fs from "node:fs";
import { markdownToJsx } from "./markdown-parser";

// Params first, handler second
export const BlogPost = createPrerenderHandler(
  // 1. Params: which slugs to pre-render
  async () => {
    const files = await glob("content/blog/*.md");
    return files.map(f => ({ slug: basename(f, ".md") }));
  },
  // 2. Handler: receives BuildContext, runs at build time
  async (ctx) => {
    const md = await fs.readFile(`content/${ctx.params.slug}.md`, "utf-8");
    const push = ctx.use(Breadcrumbs);
    push({ label: ctx.params.slug, href: `/blog/${ctx.params.slug}` });
    return <Article content={markdownToJsx(md)} />;
  }
);

// urls.tsx — used like any handler
path("/blog/:slug", BlogPost, { name: "blog.post" })
```

```ts
// Static page, no params
export const About = createPrerenderHandler(
  async (ctx) => {
    const content = await fs.readFile("content/about.md", "utf-8");
    return <Page content={markdownToJsx(content)} />;
  }
);

path("/about", About, { name: "about" })
```

```ts
// Passthrough: handler stays in bundle, live fallback for unknown params
export const ProductPage = createPrerenderHandler(
  async () => {
    const top = await db.query("SELECT id FROM products WHERE featured");
    return top.map(p => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.query("SELECT * FROM products WHERE id = ?", ctx.params.id);
    return <Product data={product} />;
  },
  { passthrough: true }
);

path("/products/:id", ProductPage, { name: "products.detail" }, () => [
  loader(ProductLoader),
  revalidate(({ actionId }) => actionId?.includes("Product") ?? false),
])
```

## Vite Plugin: `exposePrerenderHandlerId`

Follows the exact same pattern as `exposeLoaderId`:

### Detection

```ts
// Regex detection (same approach as exposeLoaderId)
const pattern = /export\s+const\s+(\w+)\s*=\s*createPrerenderHandler\s*\(/g;
```

### Build-time flow

1. **`buildStart()`**: scan `src/` for files containing `createPrerenderHandler`.
   Build a registry of prerender handler exports (file path → export names).

2. **Pre-render execution**: for each handler, resolve the params function,
   execute the handler with `BuildContext` for each param set, collect Flight
   payloads.

3. **Module transform**: in non-RSC or production RSC environments, replace
   the entire export with a stub:

```ts
// Original (blog-post.tsx)
export const BlogPost = createPrerenderHandler(getParams, handler);

// Stubbed (what ships to the server bundle)
export const BlogPost = { __brand: "prerenderHandler", $$id: "abc123#BlogPost" };
```

The original module (blog-post.tsx) and its imports (node:fs, markdown-parser)
are never imported in the production bundle. The stub is a plain object —
same as loader stubs.

### Stub behavior at runtime

The stub is never called as a component. The `B` segment resolver sees
the `$$id`, looks up the pre-rendered Flight payload, and serves it directly.
The stub exists to keep the route definition valid and the segment tree stable.

If the stub is somehow called (bug), it throws a descriptive error.

## Sub-use Semantics

Everything inside the path's `use()` callback is part of the `B` segment
and gets pre-rendered:

```ts
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  layout(<PostLayout />, () => [        // inside B → pre-rendered
    loader(PostMetaLoader),              // live at runtime, bundled normally
  ]),
  parallel({ "@sidebar": <Sidebar /> }),  // inside B → pre-rendered
])
```

### Node APIs in sub-use items

If a parallel, child layout, or any sub-component inside the `B` segment uses
node APIs (`node:fs`, build-time-only libraries), it must be wrapped in
`createPrerenderHandler` (static, no `getParams`). This makes it detectable
and stubbable by the Vite plugin — same as the route handler itself.

```ts
// sidebar.tsx — uses node:fs, must be a createPrerenderHandler
import fs from "node:fs";

export const BlogSidebar = createPrerenderHandler(
  async (ctx) => {
    const files = await fs.readdir("content/blog/");
    return <Sidebar posts={files.map(f => basename(f, ".md"))} />;
  }
);

// urls.tsx — BlogSidebar is stubbable, node:fs excluded from bundle
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  parallel({ "@sidebar": BlogSidebar }),  // stubbable
])
```

Without the wrapper, passing `<Sidebar />` directly as JSX would pull
`node:fs` into the server bundle. The `createPrerenderHandler` wrapper
ensures the Vite plugin can replace it with a stub at build time.

Loaders already have `createLoader` for this purpose. The static
`createPrerenderHandler` variant fills the same role for components and
parallel slots that need node APIs at build time.

### Controlling the pre-render boundary

The developer controls what gets pre-rendered by placing content inside
or outside the path:

```ts
// Option A: parallel INSIDE the path — pre-rendered with the route
path("/blog/:id", BlogPost, { name: "blog.post" }, () => [
  layout(<BlogLayout />, () => [
    parallel({ "@recent": RecentBlogs }),  // inside B segment, stubbable
  ]),
])

// Option B: parallel OUTSIDE in parent layout — live, cache() available
layout(<BlogLayout />, () => [
  parallel({ "@recent": <RecentBlogs /> }, () => [
    cache({ ttl: 300 }),  // normal runtime cache, not pre-rendered
  ]),
  path("/blog/:id", BlogPost, { name: "blog.post" }),
])
```

### Restrictions

`loading()` is ignored without `passthrough: true`. Pre-rendered segments
are fully resolved at build time and never suspend. With `passthrough: true`,
`loading()` works normally for live fallback renders (unknown params that
hit the handler at runtime).

Without `passthrough: true`, `prerender()` is incompatible with
`revalidate()` on the same path. The handler is eliminated from the
bundle — there is nothing to re-render at runtime. Using both produces
a build-time warning.

With `passthrough: true`, `revalidate()` is allowed since the handler
stays in the bundle and can render live.

Server actions on pre-rendered pages work but are handled client-side
only. Actions do not cause the `B` segment to re-render — the
pre-rendered content stays as-is (unless `passthrough: true` and
`revalidate()` triggers a live re-render).

## Build Segment: `B` type

`createPrerenderHandler` introduces a new segment type: `B` (build). The `B`
segment wraps the route's subtree, similar to how child layouts wrap routes.
It is the atomic unit of pre-rendering — the entire `B` segment is served
from cache, never partially.

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
4. If not found and `passthrough: true` — render live via handler
5. If not found and `passthrough: false` — handler eliminated, return fallback

## Dev Mode

In dev mode, `createPrerenderHandler` is treated as a normal handler. The
route renders live on first request — same as normal SSR. No stubbing, no
build-time pre-rendering. The handler runs with a full runtime context
(not BuildContext) in dev.

A dev-mode warning is emitted to remind that pre-rendering only happens
during production builds.

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

### Step 5: Discover pre-render handlers

`buildStart()` scans `src/` for `createPrerenderHandler` exports (same
pattern as `exposeLoaderId`). Builds registry: file path → export names.

### Step 6: Execute pre-renders

For each handler in the registry:
1. Resolve the params function to get the list of param sets
2. For each param set, create a `BuildContext` with those params
3. Execute the handler (loaders are not executed — they run at request time)
4. Render the `B` segment subtree to RSC Flight payload
5. Store keyed by router id + route name + param hash

### Step 7: Stub handlers in production bundle

Replace `createPrerenderHandler` exports with plain object stubs (unless
`passthrough: true`). Same mechanism as `generateClientLoaderStubs()` in
`exposeLoaderId`. The original module and its imports are excluded from
the bundle.

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
  pr?: true;       // has pre-rendered B segment
  pt?: true;       // passthrough (handler available for live fallback)
  // ...existing fields
}
```

## Vite Plugin Configuration

Build-time pre-rendering is controlled via the Vite plugin:

```ts
// vite.config.ts
rango({
  prerender: {
    // Max concurrent render operations.
    // Default: 5
    concurrency: 5,

    // Per-render timeout in ms.
    // Default: 30000
    timeout: 30_000,
  },
})
```

Error handling uses the router's existing `onError` handler.

## Constraints

### Loaders are live, not pre-rendered

Loaders run at request time as normal, even on pre-rendered routes. They are
bundled into the server build and need `cache()` for caching — same as any
other route. Users should not use APIs in loaders that won't exist on the
target deployment (e.g., don't use `node:fs` in a loader deploying to
Cloudflare).

### No revalidate() without passthrough

`revalidate()` is incompatible with `createPrerenderHandler` when
`passthrough: false` (default). The handler is eliminated from the bundle.
Using both produces a build-time warning.

With `passthrough: true`, `revalidate()` works normally.

### Handle data is frozen

Handle values pushed during pre-rendering are baked into the Flight payload.

### Server actions and loaders

Server actions on pre-rendered pages work. The pre-rendered handler output
(the `B` segment) stays as-is — it is not re-rendered. However, since
loaders are live and bundled, actions can trigger loader revalidation
normally. This means a pre-rendered page can have dynamic loader data
that updates via actions, while the handler's static shell remains frozen.

With `passthrough: true`, `revalidate()` can also trigger a full live
re-render of the handler itself.

## Interaction with Existing DSL

| DSL item       | Interaction with `createPrerenderHandler`               |
|----------------|--------------------------------------------------------|
| `loader()`     | Live at runtime, bundled normally. Use `cache()` for caching |
| `revalidate()` | Not allowed without passthrough. Allowed with passthrough |
| `cache()`      | Orthogonal — use on parent layouts, not on pre-rendered routes |
| `layout()`     | Child layouts inside `B` are pre-rendered, parent layouts are live |
| `parallel()`   | Parallel slots inside `B` are pre-rendered              |
| `middleware()`  | Skipped during pre-render (no request)                  |
| `loading()`    | Ignored without passthrough. With passthrough, works for live fallback renders |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered)  |

## Open Questions

- **Fallback for unknown params without passthrough**: handler is eliminated —
  404? Generic fallback? notFoundBoundary?
- **Incremental builds**: add one blog post — re-render all 10,000 or diff
  against existing output and render only new/changed?
- **Client navigation to pre-rendered routes**: partial update system needs
  to serve pre-rendered Flight payload for `B` segments during RSC fetch.
- **Shared module detection**: if a module is imported by both a pre-rendered
  handler and a live handler, the plugin must NOT exclude it from the bundle.
  Same challenge as `exposeLoaderId` with mixed exports — solved there by
  falling back to per-export transforms instead of full module replacement.
