# Pre-rendering API Design

## Core Principle

Pre-rendering is **caching at build time**. Same serialization format, same
deserialization path, same segment system rendering. The only difference is
WHEN the data is produced.

```
Cache:      Request → handler runs → serializeSegments() → store in KV/memory
Prerender:  Build   → handler runs → serializeSegments() → store in bundle/KV

Both at runtime:
  Request → lookup stored segments → deserializeSegments() → segment system → render
```

There are NO static files. No `.html`, no `.rsc` served from assets. The worker
handles every request. It reads pre-computed data instead of executing handler code.

### Relationship to Caching

```
                    ┌─────────────────────┐
                    │   Segment System    │
                    │  renderSegments()   │
                    └─────────┬───────────┘
                              │
                    ┌─────────┴───────────┐
                    │  Resolved Segments  │
                    │  (same format)      │
                    └─────────┬───────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     ┌────────┴──────┐ ┌─────┴─────┐ ┌───────┴───────┐
     │   Fresh       │ │  Cached   │ │ Pre-rendered  │
     │   (handler    │ │  (runtime │ │ (build-time   │
     │    runs)      │ │   store)  │ │  store)       │
     └───────────────┘ └───────────┘ └───────────────┘

All three produce the same ResolvedSegment[] format.
All three feed into the same rendering pipeline.
```

Pre-rendering reuses from the cache implementation:
- `serializeSegments()` / `deserializeSegments()` from cache-scope.ts
- `handleStore.replaySegmentData()` from cache lookup middleware
- `renderSegments()` from segment-system.tsx
- The entire RSC/HTML rendering pipeline

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

**All use items inside the path receive `BuildContext` during pre-rendering.**
This includes child layouts, parallels, and any `createPrerenderHandler`
used as sub-components. They all run at build time with no request — the
entire B segment tree operates in build context. This is different from
the normal server context these items would receive at runtime.

Loaders are the exception — they are not part of the pre-render pipeline.
They run at request time with the full server context and are bundled
normally. Data needed at build time should be fetched directly in the
handler (e.g., `fs.readFile`, inline queries).

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

Server actions on pre-rendered pages work normally. Actions do not cause
the `B` segment to re-render — the pre-rendered handler output stays
frozen. Loaders are live and can be revalidated by actions as usual.
With `passthrough: true` and `revalidate()`, the handler itself can
re-render live.

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
`{router-hash}/{route-name}/{param-hash}`:

```
dist/static/__<hash>/
  routes.json          (existing — route manifest)
  prefixes.json        (existing — prefix tree)
  prerender/
    __a1b2c3/                          # router hash (from createRouter())
      blog.post/                       # route name
        d4e5f6a7.flight                # hash of { slug: "hello-world" }
        b8c9d0e1.flight                # hash of { slug: "getting-started" }
      products.detail/                 # route name
        f2a3b4c5.flight                # hash of { category: "shoes", id: "nike-1" }
      about/                           # static route (no params)
        _.flight                       # single entry, no param hash needed
    __e6f7a8/                          # second router (another createRouter())
      admin.dashboard/
        _.flight
```

Routers created via `createRouter()` are anonymous — they have no names, only
mount indices which can change if route order changes. The router hash is a
deterministic hash of the router's identity (e.g., its route pattern tree or
mount path) so the key is stable across builds. Each router gets its own
namespace. The param hash is a deterministic hash of the sorted param
key-value pairs so the runtime can reconstruct the lookup key from matched
params without an index file.

## Build Pipeline

The existing build pipeline already:
1. Runs all route patterns via `RSCRouterContext` (`generate-manifest.ts`)
2. Captures route names, patterns, ancestry, constraints
3. Builds a trie for O(path_length) matching (`route-trie.ts`)
4. Writes static files to `dist/static/`

Pre-rendering extends step 1-4. All pre-render execution happens **inside
the Vite RSC build** — no separate server, no Miniflare, no HTTP, no child
process. We are already in the RSC environment during the build.

### Step 5: Discover pre-render handlers

`buildStart()` scans `src/` for `createPrerenderHandler` exports (same
pattern as `exposeLoaderId`). Builds registry: file path → export names.

### Step 6: Execute pre-renders

Happens during the RSC build phase. The handlers are already loaded —
we just call them:

1. Import the handler (already in the RSC build environment)
2. Call `getParams()` to get the list of param sets
3. For each param set, create a `BuildContext` with those params
4. Call the handler → get ReactNode
5. Call `serializeSegments()` (same function the cache uses)
6. Collect handle data
7. Store as `PrerenderEntry` keyed by router-hash + route-name + param-hash

No server. No HTTP. No `worker.fetch()`. The handler is a function,
we call it, serialize the output. Same as how caching calls
`serializeSegments()` after a handler runs at request time.

### Step 7: Stub handlers in production bundle

Replace `createPrerenderHandler` exports with plain object stubs (unless
`passthrough: true`). Same mechanism as `generateClientLoaderStubs()` in
`exposeLoaderId`. The original module and its imports are excluded from
the bundle.

This is the **only piece from the Vite plugin that affects the production
bundle**. Everything else (discovery, execution, serialization) is
build-time only.

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

### What is NOT needed

The following are artifacts of the static file approach and should NOT
exist in the implementation:

- `generatePrerenderScript()` — no child process needed
- Miniflare worker setup — no server needed
- `worker.fetch()` calls — no HTTP needed
- Static `.html` / `.rsc` file writing in `dist/client/` — no static files
- `prerenderPaths` virtual module — browser doesn't need to know
- Browser-side static `.rsc` fetch logic in `navigation-client.ts` — gone
- Browser-side prerender transformation in `partial-update.ts` — gone

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
| `cache()`      | Orthogonal — use on parent layouts and loaders. Covers ISR-like revalidation |
| `layout()`     | Child layouts inside `B` are pre-rendered, parent layouts are live |
| `parallel()`   | Parallel slots inside `B` are pre-rendered              |
| `middleware()`  | Skipped during pre-render (no request)                  |
| `loading()`    | Ignored without passthrough. With passthrough, works for live fallback renders |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered)  |

## E2E Test Plan

### Basic pre-rendering
- Static route (no params): md file renders correctly in production build
- Dynamic route (with params): multiple md files, each slug resolves to correct content
- Dev mode: same routes render on-demand, no stubbing

### BuildContext type safety
- Handler receives `BuildContext`, not the full runtime context
- `ctx.params` is typed from the route pattern
- `ctx.url` and `ctx.pathname` are synthetic (built from pattern + params)
- `ctx.use(handle)` returns push function for handle data
- Accessing `ctx.req`, `ctx.headers`, `ctx.cookies`, `ctx.env` throws
  descriptive errors at build time (not silent undefined)
- Sub-use items (child layouts, parallels, `createPrerenderHandler` for
  parallels) all receive `BuildContext` during pre-rendering, not the
  normal server context — request APIs throw in all of them
- Sub-use items receive the same params from the parent path

### Middleware is skipped during pre-rendering
- Middleware on the route does NOT run at build time (no request)
- Middleware variables are not available in `BuildContext`
- Middleware still runs at request time for live loaders on the same route
- Route with middleware + pre-rendered handler: middleware runs for loaders,
  handler output comes from pre-rendered cache

### Handler elimination
- Production build does NOT contain `node:fs` or markdown imports from handler
- Handler stub is a plain object with `$$id`
- Accessing a pre-rendered route serves the Flight payload, not the handler

### Loaders on pre-rendered routes
- Loader on a pre-rendered route runs at request time
- Loader data is fresh per request (not frozen with handler)
- Loader with `cache()` respects TTL

### Server actions with loaders
- Action on a pre-rendered page triggers loader revalidation
- Loader data updates after action, handler shell stays frozen
- Verify the B segment is NOT re-rendered (handler output unchanged)
- Action with `passthrough: true` + `revalidate()` re-renders the handler

### Tree structure stability
- Same segment tree shape across SSR, client navigation, and action renders
- No React remounts or state loss when navigating to/from pre-rendered routes
- Client state (useActionState, refs, local state) preserved across actions

### Sub-use semantics
- Child layout inside path is pre-rendered
- Parallel slot inside path is pre-rendered
- Parallel using `createPrerenderHandler` (node APIs) is stubbed correctly
- Content outside the path (parent layouts) stays live

### Edge cases
- Empty `getParams` returns (no params to pre-render): no Flight payloads written, no error
- `getParams` throws: build fails with clear error via router `onError`
- Handler throws for one param set: that param fails, others succeed
- Duplicate params in `getParams`: deduplicated by param hash
- Route with no `name` in path options: build error (name required for storage key)
- Pre-rendered route with no matching Flight payload at runtime (deleted/corrupted):
  graceful fallback vs 500
- Mixed file: module exports both `createPrerenderHandler` and a normal export —
  plugin must NOT eliminate the entire module

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

## Runtime Flow

At runtime, the worker handles ALL requests — direct visits, client-side
navigation, and partial requests. The browser never knows a route is
pre-rendered.

```
Request: GET /articles
  │
  ▼
┌──────────────────────────────────────────────────┐
│  RSC Handler                                      │
│                                                   │
│  1. Route match finds B segment with $$id         │
│                                                   │
│  2. Look up pre-rendered Flight payload           │
│     (by router-id + route-name + param-hash)      │
│                                                   │
│  3. deserializeSegments() (same as cache read)    │
│     replayHandleData() (same as cache read)       │
│                                                   │
│  4. Pass segments to segment system               │
│     renderSegments() (normal path)                │
│     IDs generated at runtime (same namespace      │
│     as live routes — no mismatch)                 │
│                                                   │
│  5. Return normal RSC or HTML response            │
│     (identical to a cache hit)                    │
└──────────────────────────────────────────────────┘
```

Works identically for:
- **Direct visits** (Accept: text/html) → SSR HTML with inline Flight data
- **Client navigation** (Accept: text/x-component) → partial RSC payload
- **Partial requests** (_rsc_partial) → only diff segments

No special browser logic. No ID mismatch. No transformation.

## Design Decision: Why NOT Static Files

An earlier implementation attempted static file generation (`.html` + `.rsc`
files served from Cloudflare assets). This approach has fundamental problems
and was abandoned:

1. **ID namespace mismatch**: Prerender runs in Node.js/Miniflare, generating
   segment IDs in a different namespace than the live worker (workerd). The
   browser must transform prerendered payloads to handle the mismatch.

2. **Dual file formats**: Need both `.html` (direct visits) and `.rsc` (client
   navigation). Double the prerender work, double the storage.

3. **Bypasses the worker**: Cloudflare assets serve files directly. The worker
   never sees the request. No middleware, no auth, no analytics, no A/B testing.

4. **Browser complexity**: Requires a `prerenderPaths` virtual module, static
   `.rsc` fetch logic, and `isPartial` transformation code — all existing only
   for prerender.

5. **Inconsistent with caching**: Cache goes through the worker and segment
   system. Static files bypass both. Two completely different paths for the
   same conceptual operation.

The cache-based approach eliminates all of these. Worker handles every request.
IDs generated at runtime. One code path for cache hits and prerender hits.

## Storage Options

Pre-rendered Flight payloads are stored in the build output, keyed by
`{router-id}/{route-name}/{param-hash}` (see Storage Layout above).

### Option A: Bundled in the worker (zero-latency)

Serialized entries embedded in the worker bundle as a JSON import.
Best for small datasets (< 1MB total). Lookup is a Map.get() — no I/O.

### Option B: KV Store

Serialized entries written to Cloudflare KV at build time.
Best for large datasets or many routes. ~1-5ms latency.

### Option C: Filesystem (dev/preview)

Serialized entries as JSON files in dist/. Used during `pnpm preview`
or local development.

A `PrerenderStore` interface decouples the lookup from the storage backend:

```ts
interface PrerenderStore {
  get(key: string): Promise<PrerenderEntry | null>;
}
```

Similar to `SegmentCacheStore` but read-only (writes happen at build time).
