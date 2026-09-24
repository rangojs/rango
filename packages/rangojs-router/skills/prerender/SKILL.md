---
name: prerender
description: Pre-render route segments at build time with Prerender (with getParams), Passthrough live fallback, Static segments, and Skip. Use when a page's content is mostly static and shouldn't render on every request, speeding up cold responses, reading build-only data (files, build env), or deciding which routes to prerender vs render live.
argument-hint: [passthrough]
---

# Pre-rendering with Prerender

Pre-rendering is **caching at build time**. `Prerender()` renders a route's
segments once per known param set during `vite build`, and `Static()` renders a
single segment once. Same serialization format, same deserialization path, same
segment system as the runtime `cache()`. The worker handles every request --
there are NO static .html or .rsc files served from assets. At runtime the
worker reads the pre-computed Flight payloads instead of executing handler code,
exactly like a cache hit; middleware and loaders still run on every request.

Use it when the page content is known at build time (markdown files, a CMS
snapshot, a fixed list of products) or needs build-only APIs such as `node:fs`.
The handler code and its imports are removed from the production bundle.

## Not this skill if…

- You want a cached HTML shell captured at runtime, with holes and loaders
  staying live per request — see `/ppr`.
- You want runtime segment caching with TTL/SWR — that is the `cache()` DSL:
  see `/caching`. Prerender is the same cache filled at build time.
- You are unsure which cache layer you need — start at `/cache-guide`.

## API: Prerender

### Route without params

```typescript
import { Prerender } from "@rangojs/router";

export const AboutPage = Prerender(async (ctx) => {
  const content = await fs.readFile("content/about.md", "utf-8");
  return <Page content={markdownToJsx(content)} />;
});

// urls.tsx
path("/about", AboutPage, { name: "about" })
```

### Dynamic Route (with params)

Params come first, handler second:

```typescript
export const BlogPost = Prerender(
  // 1. Params: which slugs to pre-render
  async () => {
    const files = await glob("content/blog/*.md");
    return files.map(f => ({ slug: basename(f, ".md") }));
  },
  // 2. Handler: runs at build time with BuildContext
  async (ctx) => {
    const md = await fs.readFile(`content/${ctx.params.slug}.md`, "utf-8");
    return <Article content={markdownToJsx(md)} />;
  }
);

// urls.tsx
path("/blog/:slug", BlogPost, { name: "blog.post" })
```

### With Passthrough (live fallback for unknown params)

Wrap a `Prerender` definition with `Passthrough()` to add a separate live handler
for unknown params at runtime. The build handler runs at build time, the live
handler runs at request time.

```typescript
import { Prerender, Passthrough } from "@rangojs/router";

export const ProductPageDef = Prerender(
  async () => {
    const top = await db.query("SELECT id FROM products WHERE featured");
    return top.map(p => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.query("SELECT * FROM products WHERE id = ?", ctx.params.id);
    return <Product data={product} />;
  },
  { concurrency: 4 }
);

// In route definition:
path("/products/:id", Passthrough(ProductPageDef, async (ctx) => {
  const product = await ctx.env.DB.query("SELECT * FROM products WHERE id = ?", ctx.params.id);
  return <Product data={product} />;
}), { name: "product" })
```

## Passthrough Wrapper

`Passthrough(prerenderDef, liveHandler)` wraps a `Prerender` definition with a
separate handler for runtime fallback. The build and live handlers are separate
functions — no `ctx.build` branching needed.

|                     | Plain `Prerender` (no wrapper)          | `Passthrough(def, liveHandler)`          |
| ------------------- | --------------------------------------- | ---------------------------------------- |
| Known params        | Served from pre-rendered Flight payload | Served from pre-rendered Flight payload  |
| Unknown params      | Handler evicted, no live fallback       | Live handler runs at request time        |
| `ctx.passthrough()` | Throws (not on Passthrough route)       | Skips artifact, defers to live handler   |
| Bundle size         | Build handler code + imports removed    | Build handler evicted, live handler kept |
| `revalidate()`      | No effect on prerendered segments       | Allowed (live handler can re-render)     |
| `loading()`         | Ignored (segments fully resolved)       | Works for live fallback renders          |

### When to use Passthrough

Use `Passthrough()` when:

- The route has a large or open-ended param space (e.g., user profiles, product pages)
- You want to pre-render popular/known params for speed but still serve unknown params live
- You need `revalidate()` on the route
- The live handler needs runtime bindings (e.g., `ctx.env.DB`)

Use plain `Prerender` (no wrapper) when:

- All possible params are known at build time (e.g., markdown files, config-driven pages)
- You want maximum bundle size reduction (handler code + node:fs imports removed)
- The route uses build-only APIs (node:fs, local files) not available at runtime

## BuildContext

Handlers receive `BuildContext` at build time, a subset of the runtime `HandlerContext`:

```typescript
interface BuildContext<TParams> {
  params: TParams; // From getParams
  build: true; // Always true at build time
  dev: boolean; // true in Vite dev mode, false during production build
  use: <T>(handle: Handle<T>) => (data: T) => void; // Push handle data
  url: URL; // Synthetic URL from pattern + params
  pathname: string; // Pathname from synthetic URL
  searchParams: URLSearchParams; // URLSearchParams from the synthetic URL (always empty for prerender)
  search: {}; // Typed search params -- always {} for prerender (no real query string)
  set(key: string, value: any): void; // Set context variable (string key)
  set<T>(contextVar: ContextVar<T>, value: T): void; // Set typed context variable
  get(key: string): any; // Read context variable (string key)
  get<T>(contextVar: ContextVar<T>): T | undefined; // Read typed context variable
  reverse(
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ): string; // URL generation
  passthrough(): PrerenderPassthroughResult; // Skip local artifact (Passthrough routes only)
  env: DefaultEnv; // Available when buildEnv is configured in rango() (throws otherwise)
  // ctx.request, ctx.res, ctx.headers throw: there is no request at build time.
  // ctx.waitUntil() is a no-op. ctx.dynamic() exists at runtime but is a no-op
  // here -- opt a URL out of a build shell from middleware instead.
}
```

`getParams` receives a smaller `GetParamsContext` (`build`, `dev`, `env`, `set`,
`reverse`). Values it stores with `ctx.set()` are copied into every param set's
handler context and read there with `ctx.get()`. `env` is the `buildEnv` from
`rango()` — build-time bindings shared by the whole build, not a live request
env.

Use `createVar<T>()` to share typed data from a Prerender handler to child layouts:

```typescript
import { Prerender, createVar } from "@rangojs/router";

interface PaginationData { current: number; total: number; }
export const Pagination = createVar<PaginationData>();

export const ArticleList = Prerender<{ page: string }>(
  async () => [{ page: "1" }, { page: "2" }],
  async (ctx) => {
    ctx.set(Pagination, { current: Number(ctx.params.page), total: 2 });
    return <Articles />;
  },
);
```

All items inside the path's use() callback (child layouts, parallels) also receive
`BuildContext` during pre-rendering. Loaders are the exception -- they run at
request time with full server context.

This is one reason prerender is a good fit for handler-first composition:
the handler and its child layouts/parallels participate in the same full
render pass, so data set with `ctx.set()` is available downstream via
`ctx.get()`.

At runtime, partial action revalidation follows a narrower rule: only
revalidated segments are recomputed. If a child segment depends on data
established by an outer handler/layout, that outer segment must also be
revalidated, or the child must load/guard the data independently.

## Supported Export Patterns

All of the following are equivalent and fully supported by the Vite transform:

```typescript
// Direct export (most common)
export const BlogPost = Prerender(getParams, handler);

// Separate declaration + named export
const BlogPost = Prerender(getParams, handler);
export { BlogPost };

// Aliased export
const InternalPage = Prerender(getParams, handler);
export { InternalPage as BlogPost };

// Aliased import
import { Prerender as cph } from "@rangojs/router";
export const BlogPost = cph(getParams, handler);
```

All patterns support whole-file stubbing, expression stubbing, and build-time
module tracking. The same applies to `Static`.

Anything else gets no build-injected id, and the call throws
`Prerender: missing $$id` when the module loads. Unsupported shapes include
`export let`/`export var`, and calling `Prerender(...)` inline — for example
directly inside `path()`. Declare it as an exported `const` and pass the
binding. (`Passthrough(def, liveHandler)` needs no id and can be written inline
in `path()`.)

## Handler Eviction

In production builds, `Prerender` exports are replaced with stubs:

```typescript
// Original
export const BlogPost = Prerender(getParams, handler);

// Stubbed (all Prerender handlers are evicted)
export const BlogPost = {
  __brand: "prerenderHandler",
  $$id: "abc123#BlogPost",
};
```

All Prerender handlers are evicted in production. The live handler for
`Passthrough()` routes lives in the urls module and is not evicted.

In client and SSR environments, ALL prerender handlers are always stubbed.

## Sub-use Semantics

Everything inside the path's use() callback is part of the pre-rendered route
subtree (the "B segment" in the design docs) and gets pre-rendered. Loaders are
the exception — they stay live:

```typescript
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  layout(<PostLayout />, () => [        // inside B -> pre-rendered
    loader(PostMetaLoader),              // live at runtime, bundled normally
  ]),
  parallel({ "@sidebar": BlogSidebar }), // inside B -> pre-rendered
])
```

Only the route's own `Prerender` handler is evicted from the bundle. If a
parallel or child layout uses build-only APIs such as `node:fs`, wrap it in
`Static()` (see "Static segments" below) so the Vite plugin can stub it too.
`layout()` and `parallel()` accept `Static()` definitions; they do not accept
`Prerender()` definitions.

```typescript
// sidebar.tsx -- uses node:fs, so it must be stubbed out of the bundle
import { Static } from "@rangojs/router";

export const BlogSidebar = Static(async () => {
  const files = await fs.readdir("content/blog/");
  return <Sidebar posts={files.map((f) => basename(f, ".md"))} />;
});

// urls.tsx
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  parallel({ "@sidebar": BlogSidebar }), // stubbable, node:fs excluded
])
```

## Static segments

`Static(handler, options?)` renders ONE segment once at build time. It has no
params and produces no URLs; it works on `layout()`, `parallel()`, and `path()`.
Use it for build-time chrome such as a docs navigation built from files, or for
a static route with no params.

```typescript
import { Static } from "@rangojs/router";

export const DocsNav = Static(async (ctx) => {
  const docs = await readDocsIndex(); // build-only I/O
  return <Nav docs={docs} />;
});

// urls.tsx
layout(DocsNav, () => [
  path("/docs/:slug", DocPage, { name: "doc" }),
]);
```

- The handler receives `StaticBuildContext`: `build`, `dev`, `env` (with
  `buildEnv`), `get`/`set`, `use(handle)`, and `reverse`. `params`, `url`,
  `pathname`, and `request` throw.
- `Static(handler, { passthrough: true })` skips the build render and keeps the
  handler in the bundle, rendering live at request time.
- `Static()` always renders sequentially (no `concurrency` option) and supports
  `throw new Skip()` (see "Skipping Entries with Skip").
- The same export rules as `Prerender` apply (`export const X = Static(...)`).

## Interaction with DSL Items

| DSL item       | Behavior with Prerender                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loader()`     | Live at runtime, bundled normally. Use `cache()` for caching.                                                                                                                                                                                                               |
| `revalidate()` | Without Passthrough: no effect on the prerendered segments (re-served from the build artifact); loader revalidation still works. With Passthrough: re-renders through the live handler.                                                                                     |
| `cache()`      | Orthogonal -- prerendered segments bypass the runtime cache. Use `cache()` on parent layouts and loaders.                                                                                                                                                                   |
| `layout()`     | Child layouts inside path are pre-rendered. Parent layouts are live.                                                                                                                                                                                                        |
| `parallel()`   | Parallel slots inside path are pre-rendered.                                                                                                                                                                                                                                |
| `middleware()` | Skipped while collecting build-time Flight payloads (no request). For `Prerender` + `ppr`, the build-shell step replays global and route middleware with `ctx.build === true`; `ctx.dynamic()` skips that shell. At request time middleware runs normally on every request. |
| `loading()`    | Ignored without Passthrough. Works for live fallback with Passthrough.                                                                                                                                                                                                      |
| `intercept()`  | Pre-rendered at build time. Intercept variant stored under `/i` key alongside main segments. At runtime, the correct variant is served based on `ctx.isIntercept`. `when` config conditions are skipped at build time (all intercepts are pre-rendered unconditionally).    |

When Passthrough revalidation is enabled, remember that revalidation is
still partial: opting a child segment into revalidation does not
implicitly re-run outer prerender-derived handlers/layouts.

## Prerender + PPR Build Shells

A `Prerender` page may also declare `ppr` on the path option. The build still
stores the Flight payload first. After that, a build-shell step ("producer B"
in the design docs) tries to bake the HTML shell for each generated URL so the
first document request can be an `x-rango-shell: HIT`.

That shell capture is request-shaped enough to run middleware safely:

- global and route middleware run before shell capture;
- middleware sees `ctx.build === true`;
- `ctx.waitUntil()` is inert during build;
- `ctx.dynamic()` skips the baked shell for that URL.

Use `ctx.build` inside middleware to avoid runtime-only side effects during
build shell capture, or call `ctx.dynamic()` to leave that route to runtime
PPR. Runtime requests still run the normal middleware chain.

Build shells are keyed by pathname and served only for requests without a query
string (after `cache.searchParams` filtering). A URL with search params has its
own shell identity and is captured at runtime. The runtime shell store is read
first, so a runtime capture supersedes the baked entry once it exists.

### Freshness of a build shell

A build-baked shell is not on a wall clock the way a pure runtime `ppr` shell is.
It serves from the first request after a deploy and keeps serving until one of:

- **a redeploy** — the `buildVersion` gate retires every build entry (like a
  React-version bump); the new build re-bakes;
- **`updateTag`** on a tag the shell carries — drops it, so the next request
  MISSes and a runtime capture takes over.

`ppr.ttl` / `swr` are staleness-only here, NOT an expiry: past `ttl` the baked
entry STILL serves and a runtime recapture is scheduled that upgrades it in place
(SWR is the upgrade path from build entry → fresher runtime entry). Because the
`Prerender` handler is evicted from the production bundle, that recapture never
re-runs the handler — it replays the same build-time segments and only refreshes
`cache()`-scoped data baked into the shell. **If nothing in the shell is
`cache()`-backed, `ttl` has nothing to refresh** — reach for `updateTag` (or a
redeploy) instead of a shorter `ttl`.

`ctx.dynamic()` opts a request off the shell axis ONLY. A `Prerender` route has
no live handler to fall back to (it was evicted), so a `dynamic()` request still
serves the build-baked segments — fresh loaders in their holes, not a fresh
handler render. There is no "fully dynamic" render for a prerendered route.

## Dev Mode

In dev there is no build pass and no handler stubbing. Instead, a request to a
prerendered route is rendered **on demand** through the dev server's
`/__rsc_prerender` endpoint, which runs the same build-time resolution in
Node.js (so `node:fs` and `buildEnv` work even when the app itself runs in
workerd). This applies to both the Node and the Cloudflare presets.

- The handler receives `BuildContext` (`ctx.build === true`, `ctx.dev === true`),
  and segments resolve exactly as in the production prerender.
- Results are memoized until you edit a file in the router's module graph, so
  `getParams()` and handler side effects run once per edit, not once per request.
  The endpoint reports `x-rango-prerender-cache: HIT | MISS`.
- If the on-demand render has no entry for the URL (unknown param, `Skip`,
  `ctx.passthrough()`, or a render error, which is logged), the request falls
  through to a live render — the Passthrough live handler when there is one.

## Storage Layout

Pre-rendered Flight payloads are stored as content-hashed modules behind a lazy
manifest in the RSC server bundle. They are not public `.rsc` files:

```
dist/rsc/
  __prerender-manifest.js
  assets/
    __pr-<content-hash>.js

# When a Prerender route also declares ppr:
  __shell-manifest.js
  assets/
    __ps-<content-hash>.js
```

The worker/function handles every request and reads these modules as build-time
cache entries. See `/deployment-caching` for how this differs from a platform
CDN static or prerender output.

## Concurrency

Prerender handlers can specify how many param sets render in parallel:

```typescript
export const BlogPost = Prerender(
  async () => posts.map(p => ({ slug: p.slug })),
  async (ctx) => <PostPage slug={ctx.params.slug} />,
  { concurrency: 4 },
);
```

Default is `1` (sequential). Only `Prerender` supports concurrency; `Static` handlers
always render sequentially.

## Skipping Entries with Skip

Throw `Skip` inside a Prerender or Static handler to skip an individual entry
without failing the build:

```typescript
import { Prerender, Skip } from "@rangojs/router";

export const BlogPost = Prerender(
  async () => [{ slug: "published" }, { slug: "draft" }],
  async (ctx) => {
    if (ctx.params.slug === "draft") {
      throw new Skip("Draft articles are not pre-rendered");
    }
    return <PostPage slug={ctx.params.slug} />;
  },
);

```

To serve skipped params live at runtime, give the definition its own name and
wrap it with `Passthrough()`; the live handler renders them:

```typescript
import { Prerender, Passthrough, Skip } from "@rangojs/router";

export const BlogPostDef = Prerender(
  async () => [{ slug: "published" }, { slug: "draft" }],
  async (ctx) => {
    if (ctx.params.slug === "draft") {
      throw new Skip("Draft articles are not pre-rendered");
    }
    return <PostPage slug={ctx.params.slug} />;
  },
);

// Live handler: runs at request time for "draft" and any unknown slug
export const BlogPost = Passthrough(BlogPostDef, async (ctx) => (
  <PostPage slug={ctx.params.slug} />
));
```

Skipped entries are excluded from the build output. With `Passthrough()`,
the live handler serves skipped params at request time.

`Skip` also works in `Static` handlers:

```typescript
import { Static, Skip } from "@rangojs/router";

export const TocSidebar = Static(() => {
  throw new Skip("Not ready for pre-rendering");
});
```

### Error behavior at build time

When a render throws a non-`Skip` error, it is **surfaced to the build** — never
baked into a frozen error page served as a 200 (issue #587). What happens next is
controlled by `prerender.onError` in your `rango()` options:

```ts
rango({ prerender: { onError: "warn" } }); // default is "fail"
```

| Handler outcome             | `onError: "fail"` (default)                  | `onError: "warn"`                |
| --------------------------- | -------------------------------------------- | -------------------------------- |
| JSX / `null`                | Normal prerender entry, log OK               | Normal prerender entry, log OK   |
| `return ctx.passthrough()`  | Skip entry, log PASS (Passthrough routes)    | Skip entry, log PASS             |
| `throw new Skip("reason")`  | Skip entry, log SKIP, continue               | Skip entry, log SKIP, continue   |
| `throw new Error("reason")` | Log FAIL, stop ALL pre-rendering, fail build | Log WARN, skip the URL, continue |
| A child component throws    | Log FAIL, stop ALL pre-rendering, fail build | Log WARN, skip the URL, continue |

The last row covers a handler that returns fine but whose tree holds an async
server component that throws while the page is rendered at build, for example
because its fetch fails. That error goes through the same policy instead of being
baked as an error row, and a `Skip` thrown there skips the URL.

With `"warn"` the errored entry is logged and left un-baked (never served as a baked
200 error page). `"warn"` is a build-unblock, not a runtime contract: the route falls
through to normal resolution — it may render live (its handler is still bundled) or
404 (once other baked entries trigger prerender handler eviction), so the outcome
depends on the rest of the build, and a skipped `Static()` handler's evicted code can
surface as an error. For DEFINED runtime behavior reach for `Passthrough()` (a live
fallback) or `throw new Skip()` (an intentional skip — works in the render fn, not
only `getParams()`); otherwise prefer the default `"fail"`.

Both `Skip` and hard errors propagate to the router's `onError` callback with phase
`"prerender"` or `"static"`; skipped entries (a `Skip`, or an error under
`"warn"`) carry `metadata.skipped: true`.

### Build logs

The build produces per-URL timing logs:

```
[rango] Pre-rendering 12 URL(s) (concurrency: 4)...
[rango]   OK   /articles/hello            (42ms)
[rango]   PASS /articles/remote-only      (5ms) - live fallback
[rango]   SKIP /articles/draft-post       (3ms) - Article is a draft
[rango] Pre-render complete: 11 done, 1 skipped (1204ms total)

[rango] Rendering 3 static handler(s)...
[rango]   OK   DocsLayout                 (28ms)
[rango]   SKIP TocSidebar                 (1ms) - Not ready
[rango] Static render complete: 2 done, 1 skipped (120ms total)
```

A `FAIL` line is logged per-URL when a handler throws a non-Skip error (with the
default `prerender.onError: "fail"`). The error is re-thrown immediately, so no
summary line is printed — the build stops at the first failure. Under
`prerender.onError: "warn"` the same case logs a `WARN` line, skips that URL, and
the build continues.

### Dev mode behavior

In dev, `Skip` runs inside the on-demand `/__rsc_prerender` render, so
build-style skip logic runs for that request. The endpoint treats it as a
prerender miss and the request falls through to a live render (see "Dev Mode").

## Per-Param Passthrough with ctx.passthrough()

On routes wrapped with `Passthrough()`, the build handler can return
`ctx.passthrough()` to skip writing a local prerender artifact for a specific
param set. At runtime, the missing entry falls through to the live handler.

```typescript
export const BlogPostDef = Prerender(
  async () => [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  async (ctx) => {
    const post = await getPost(ctx.params.slug);
    if (!post) return ctx.passthrough();
    return <article>{post.content}</article>;
  },
);

export const BlogPost = Passthrough(BlogPostDef, async (ctx) => {
  const post = await getPost(ctx.params.slug);
  return <article>{post.content}</article>;
});
```

### Semantics

- JSX or `null` from the build handler produces a normal prerender entry.
- `ctx.passthrough()` returns a sentinel that signals "no local artifact".
  The build skips the manifest entry for that param set.
- `ctx.passthrough()` on a route not wrapped with `Passthrough()` throws.
- `ctx.passthrough()` at runtime (`ctx.build === false`) also throws.
  It is a build-time-only control flow.
- `getParams()` still enumerates the param set; the build handler decides
  per-param whether to produce an artifact or defer to the live handler.

### Difference from Skip

| Mechanism           | Effect on build        | Runtime behavior                                       |
| ------------------- | ---------------------- | ------------------------------------------------------ |
| `throw new Skip()`  | Skips entry, logs SKIP | No artifact, no live fallback unless Passthrough route |
| `ctx.passthrough()` | Skips entry, logs PASS | Always defers to live handler (requires Passthrough)   |

Use `ctx.passthrough()` when you want the live handler to run at request time
for specific params. Use `Skip` when you want to exclude params entirely.

### Use case: Remote storage

`ctx.passthrough()` enables a pattern where build-time data is stored in a
remote KV store instead of the local prerender manifest. The build handler
pre-computes data during `getParams`, pushes it to KV, then calls
`ctx.passthrough()` so the local build skips the artifact. At runtime,
the Passthrough live handler reads from KV:

```typescript
export const ProductDef = Prerender(
  async () => {
    const products = await db.getFeaturedProducts();
    for (const p of products) {
      await kv.put(`product:${p.id}`, await renderProduct(p));
    }
    return products.map(p => ({ id: p.id }));
  },
  async (ctx) => {
    // At build time: skip local artifact, data is in KV
    return ctx.passthrough();
  },
);

export const Product = Passthrough(ProductDef, async (ctx) => {
  // At runtime: read from KV, fall back to DB
  const cached = await kv.get(`product:${ctx.params.id}`);
  if (cached) return cached;
  return <Product data={await ctx.env.DB.getProduct(ctx.params.id)} />;
});
```

### Build logs

Passthrough entries are logged distinctly:

```
[rango]   OK   /blog/a                          (42ms)
[rango]   PASS /blog/b                          (3ms) - live fallback
[rango]   OK   /blog/c                          (38ms)
```

## Edge Cases and Constraints

### Loaders are always live

Loaders on pre-rendered routes run at request time. They are bundled normally
and need `cache()` for caching. Do not use build-only APIs in loaders.

### Build-time handle data is frozen

Handle values pushed via `ctx.use()` DURING pre-rendering (handler pushes at
build) are baked into the Flight payload and do not update at request time.
Loader pushes are the exception by construction: loaders run live at request
time (previous section), so a loader-pushed handle (a data-derived Meta title,
say) is request-time data — delivery follows the loader race model, see
`/loader` → "Writing Handles from Loaders".

### Server actions work normally

Actions run normally; what changes is the re-render after them. Loaders are live
and are revalidated by actions as usual.

- **Plain `Prerender`**: the handler was evicted, so the action re-render serves
  the stored prerender entry again. The prerendered output stays frozen; the
  action's return value reaches the client as usual.
- **`Passthrough()`**: the action re-render runs the live handler, replacing the
  prerendered output. To keep the frozen tree mounted after actions (for example
  so a client component's form state survives), suppress action
  revalidation on the route while keeping navigation defaults:
  `revalidate((ctx) => (ctx.isAction() ? false : undefined))`.

A handler may also embed an inline `"use server"` action that closes over
build-time values; the captured values are frozen at build and the action body
runs live when invoked.

### Empty getParams

If `getParams` returns an empty array, no Flight payloads are written. No error.
Every request to the route then behaves like an unknown param.

### Route name is required

Routes using `Prerender` must have a `name` in path options.
The name is used as the storage key for Flight payloads.

### revalidate() needs Passthrough

Without `Passthrough()` the handler is evicted, so there is nothing to
re-render: a revalidation re-serves the prerendered segments from the build
artifact. `revalidate()` on the route's loaders still works. No warning is
emitted — wrap the route in `Passthrough()` when its segments must re-render.

### Tag invalidation does not reach prerendered segments

`updateTag()`/`revalidateTag()` evict runtime cache entries. They do not refresh
a prerendered route's build-time Flight payload, which is served before the tag
system is consulted, and a `cacheTag()` inside a `"use cache"` function that runs
during the build has no runtime effect. A redeploy replaces the payload. To make
a route tag-invalidatable, serve it from the runtime cache instead (`cache()`,
or a `Passthrough()` live handler). A build-baked **ppr shell** is different: a
tag it carries does drop it (see "Freshness of a build shell").

### loading() is ignored without Passthrough

Pre-rendered segments are fully resolved at build time and never suspend.
With `Passthrough()`, `loading()` works for live fallback renders.

## Complete Example

Known guides are pre-rendered; any other slug is rendered live by the
Passthrough handler.

```typescript
// pages/guides-handler.tsx
import { Prerender, Passthrough } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
};

export const GuidesDetailDef = Prerender<{ slug: string }>(
  async () => Object.keys(knownGuides).map((slug) => ({ slug })),
  async (ctx) => {
    const title = knownGuides[ctx.params.slug] ?? `Guide: ${ctx.params.slug}`;
    return (
      <div>
        <h1>{title}</h1>
        <p>Slug: {ctx.params.slug}</p>
        <nav>
          <Link to={ctx.reverse("guides.detail", { slug: "routing" })}>Routing</Link>
          {" | "}
          <Link to={ctx.reverse("guides.detail", { slug: "dynamic-test" })}>Dynamic</Link>
        </nav>
      </div>
    );
  },
);

export const GuidesDetail = Passthrough(GuidesDetailDef, async (ctx) => {
  const title = knownGuides[ctx.params.slug] ?? `Guide: ${ctx.params.slug}`;
  return (
    <div>
      <h1>{title}</h1>
      <p>Slug: {ctx.params.slug}</p>
      <nav>
        <Link to={ctx.reverse("guides.detail", { slug: "routing" })}>Routing</Link>
        {" | "}
        <Link to={ctx.reverse("guides.detail", { slug: "dynamic-test" })}>Dynamic</Link>
      </nav>
    </div>
  );
});

// pages/guides.tsx
import { urls } from "@rangojs/router";
import { GuidesDetail } from "./guides-handler.js";

export const guidesPatterns = urls(({ path }) => [
  path("/:slug", GuidesDetail, { name: "detail" }),
]);

// urls.tsx
import { urls } from "@rangojs/router";
import { guidesPatterns } from "./pages/guides.js";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/guides", guidesPatterns, { name: "guides" }),
]);
```

## Interaction with intercept()

When a pre-rendered route is also the target of an `intercept()`, the build system
resolves the intercept handler at build time and stores a combined entry (main
segments + intercept segments) under an `/i`-suffixed key alongside the main entry:

```
prerender store keys:
  "blog.post/a1b2c3"      -> main segments (full page)
  "blog.post/a1b2c3/i"    -> main segments + intercept segments (modal variant)
```

At runtime, the cache-lookup middleware checks `ctx.isIntercept`:

- **Intercept navigation**: looks up `paramHash/i` first. If found, yields
  the combined entry. `handleCacheHitIntercept()` extracts intercept segments
  (filtered by `namespace?.startsWith("intercept:")`) and sets up slots.
- **Direct navigation**: looks up `paramHash` (no suffix). Standard prerender path.
- **Intercept miss (no `/i` entry)**: falls through to the normal pipeline so
  intercept-resolution middleware runs live. This handles `when` config conditions
  that prevented pre-rendering.

The `when` config selector receives an `InterceptSelectorContext` with `from.pathname`
which is unknown at build time. All intercepts are pre-rendered unconditionally;
`when` is evaluated at runtime by the intercept-resolution middleware.

### Example: Pre-rendered route with intercept

```typescript
// Route handler is pre-rendered at build time
export const ProductDetail = Prerender(
  async () => [{ slug: "shoes" }, { slug: "jacket" }],
  async (ctx) => <ProductPage slug={ctx.params.slug} />,
);

// urls.tsx
layout(ShopLayout, () => [
  path("/:slug", ProductDetail, { name: "detail" }, () => [
    loader(ProductLoader),
  ]),

  // Intercept detail from shop index into a modal.
  // At build time, this is resolved and stored under the /i key.
  intercept(
    "@modal",
    ".detail",
    <ProductModal />,
    { when: ({ from }) => from.pathname === "/shop" },
    () => [loader(ProductLoader)],
  ),
])
```

Both `ProductPage` (main) and `ProductModal` (intercept) are frozen at build time.
Loaders run fresh at request time for both variants.

## Trie Flags

Pre-rendered routes set flags on the route trie leaf at build time:

- `pr: true` -- route has pre-rendered segment data
- `pt: true` -- route wrapped with `Passthrough()` (live handler available)

At runtime, the cache-lookup middleware uses these flags:

- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to Passthrough live handler
- `pr + miss` (no pt) -- fall through to the stubbed handler, which throws a
  not-found error ("No prerender data found for this route"); there is no live render

## Related

- `/cache-guide` — how prerendering compares with the runtime cache layers
- `/caching` — runtime `cache()` segments and loader caching
- `/ppr` — the `ppr` path option; combine with `Prerender` for build-time shells
- `/shell-manifest` — prerendered shell feeding ids to a live loader
- `/deployment-caching` — why prerender output is not a CDN static file
- `/loader` — loaders stay live on prerendered routes
