---
name: prerender
description: Pre-render route segments at build time with Prerender (with getParams), Passthrough live fallback, Static segments, and Skip, refresh them from a running app with on-demand prerender (Prerender onDemand + router.prerender, ISR-style), and warm any other route's runtime caches (ppr shell, cache(), "use cache", document cache) before traffic with the same router.prerender. Use when a page's content is mostly static and shouldn't render on every request, speeding up cold responses, reading build-only data (files, build env), refreshing one page from a webhook, cron or queue without a redeploy, removing a deleted item's page (prerender.remove, or notFound() in a refresh), making routes ready after a deploy or an updateTag so no visitor pays the first render, or deciding which routes to prerender vs render live.
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

- You want a cached HTML shell captured at runtime, with holes staying live
  per request (loaders without `ssr: false` run per request; `ssr: false`
  loaders bake) — see `/ppr`.
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
subtree and gets pre-rendered. Loaders are the exception — they stay live:

```typescript
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  layout(<PostLayout />, () => [        // inside the route -> pre-rendered
    loader(PostMetaLoader),              // live at runtime, bundled normally
  ]),
  parallel({ "@sidebar": BlogSidebar }), // inside the route -> pre-rendered
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
stores the Flight payload first. After that, the build-time shell capture
tries to bake the HTML shell for each generated URL so the first document
request can be an `x-rango-shell: HIT`. A route partitioned by
`cache({ key })` or a store `keyGenerator` never serves that build shell (the
build captured one partition); each partition captures at runtime, a
once-per-route warning says so, and a `keyGenerator` that returns the default
key unchanged keeps it. When the route's `cache()` scope (its own, or one
inherited from a layout) refuses a request — `cache(false)`, or a
`condition()` that returns false — that request gets no shell at all, the
build shell included: it renders like a cache miss.

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

Handle values behave as on any `ppr` shell (`/ppr` → "Handles on a shell
HIT"): a value an `ssr: false` loader pushes settled is in the shell's HTML and
in the data a HIT hydrates with, and one it pushes as a promise arrives after
hydration. The prerendered payload holds only the handler's pushes (loaders
never run at build), so the shell entry keeps the loader pushes its HTML
rendered, on a build-baked shell and on one captured at runtime alike. A shell
stored by router 0.21 or earlier lacks them, and a promise-free `ssr: false`
loader's settled push fails hydration on its HITs until the shell is replaced
(#1057).

### Freshness of a build shell

A build-baked shell is not on a wall clock the way a pure runtime `ppr` shell is.
It serves from the first request after a deploy and keeps serving until one of:

- **a redeploy** — the new build ships its own build shell manifest and
  re-bakes. A shell stored at runtime for the route is replaced when the
  router's document version changes, and a change of the prerendered payload
  changes it (a Prerender payload is part of its router's document version, not
  its data version, so cached data is kept); a React-version bump also retires
  it;
- **`updateTag`** on a tag the shell carries — drops it, so the next request
  MISSes and a runtime capture takes over.

`ppr.ttl` / `swr` are staleness-only here, NOT an expiry: past `ttl` the baked
entry STILL serves and a runtime recapture is scheduled that upgrades it in place
(SWR is the upgrade path from build entry → fresher runtime entry). Because the
`Prerender` handler is evicted from the production bundle, that recapture never
re-runs the handler — it replays the same build-time segments and only refreshes
what the capture reads again: `cache()`-scoped data baked into the shell, and
the data of `ssr: false` loaders, which run at every capture. **If the shell
bakes neither, `ttl` has nothing to refresh** — reach for `updateTag` (or a
redeploy) instead of a shorter `ttl`.

`ctx.dynamic()` opts a request off the shell ONLY. A `Prerender` route has
no live handler to fall back to (it was evicted), so a `dynamic()` request still
serves the build-baked segments — fresh loaders, not a fresh handler render.
There is no "fully dynamic" render for a prerendered route.

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
- On an on-demand route, a refresh (`router.prerender()`) whose build handler
  returns `ctx.passthrough()` reports `skipped-passthrough` and stores a
  "removed" marker for that param, so the live handler answers there too, not
  a page a refresh stored or the build baked earlier (see "Remove a page").
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

The exception is an `ssr: false` loader on a `Prerender` + `ppr` route: the
build-time shell capture runs it and bakes its settled data into the shell,
and a shell HIT runs it only when its return carries promises (`/ppr` → "The
bake lane"). The Flight payload collection itself still skips loaders.

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
  action's return value reaches the client as usual. An `onDemand` route serves
  its on-demand entry first, and re-sends its own segments from it, so an
  action that calls `router.prerender()` for the page shows the new entry.
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
a prerendered route's payload, build-time or on-demand: the prerender store is
read before the tag system is consulted, and a `cacheTag()` inside a
`"use cache"` function that runs during the build has no runtime effect. A
redeploy replaces the build payload; because a Prerender payload is part of its
router's document version, a deploy whose only change is new prerendered content
keeps cached data and replaces stored HTML (shells, document-cache responses)
for that router.

To refresh a prerendered page without a redeploy, opt the route into
**on-demand prerender** and call `router.prerender()` (next section); its tags
are a separate namespace, invalidated with the runner's `markStale()`. To
make a route invalidatable by `updateTag()`, serve it from the runtime cache
instead (`cache()`, or a `Passthrough()` live handler). A build-baked **ppr
shell** is different: a tag it carries does drop it (see "Freshness of a build
shell").

## On-demand refresh (ISR)

Build-time prerender freezes a page until the next deploy. On-demand prerender
lets a running app re-render one page and serve that to everyone: a CMS
webhook, a cron sweep, a queue consumer, or a server action calls
`router.prerender()`, the router renders the route with route params and env
only (no request), and writes the payload to a durable store that the serve
path reads before the build manifest.

### Opt a route in

```typescript
export const ProductPage = Prerender(
  async () => [{ id: "featured" }],
  async (ctx) => <Product data={await ctx.env.PRODUCTS.get(ctx.params.id)} />,
  {
    onDemand: {
      ttl: 3600, // soft staleness, seconds; overrides the router `ttl`
      tags: ({ params }) => [`product:${params.id}`], // or a string[]
    },
  },
);
```

`onDemand: true` uses the router defaults. Any truthy spelling works (a literal,
a spread, an imported const). The opt-in keeps the handler in the production
bundle, which plain `Prerender` evicts. `Passthrough()` alone is not an opt-in:
wrap an `onDemand` definition to get both a live fallback and refreshes.

`onDemand` and the `ppr` path option cannot be combined: the route definition
throws, because a refresh cannot replace a captured document shell atomically.

### Configure a store

```typescript
import { createKVPrerenderStore } from "@rangojs/router/prerender/cloudflare";

export const router = createRouter<Env>({
  prerender: (env) => ({
    store: createKVPrerenderStore(env.PRERENDER_KV),
    ttl: 3600, // default soft TTL; absent = never stale
    // Optional. Its presence turns on stale-while-revalidate scheduling.
    onRevalidate: (target, liveEnv) => liveEnv.PRERENDER_QUEUE.send({ target }),
  }),
});
```

The option takes an object or a factory resolved per request and per trigger
call, like `cache`. `createMemoryPrerenderStore()` from
`@rangojs/router/prerender` is a single-process store (Node, tests). In dev a
zero-config in-memory store is used when the option is absent.

### Trigger a refresh

```typescript
const prerender = router.prerender({ env, ctx });
await prerender("/products/42");
await prerender(
  { route: "products.detail", params: { id: "42" } },
  { throwOnError: true },
);
await prerender.many(targets, { concurrency: 4, onlyIfStale: true });
await prerender.markStale(["product:42"]);
await prerender.remove("/products/42"); // see "Remove a page"
```

`router.prerender({ env, ctx })` binds the live env (and the Cloudflare `ctx`,
absent on Node) once and returns the runner synchronously; binding does no
work. Per-call options (`onlyIfStale`, `throwOnError`, and `concurrency` on
`.many()`) go on each call.

`.many()` runs targets through a bounded pool and returns one result per target
in input order. `concurrency` defaults to 1 (any invalid value is 1). A large
list belongs in a queue, one message per batch: one invocation runs under the
platform's time and CPU limits, so a single `.many()` over thousands of targets
will not finish.

A refresh always renders and replaces; `{ onlyIfStale: true }` (cron sweeps)
skips a fresh entry and returns `already-fresh`. The result is inspectable
(`{ ok, path: "on-demand", status, key, tags, ttl }`); statuses are `rendered`,
`already-fresh`, `removed` (the render hit `notFound()`, see "Remove a
page"), `no-match`, `no-store`, `skipped-personalized`,
`skipped-unsupported-target` (a target with `?search` or `#hash`),
`skipped-passthrough`, `render-failed` and `store-failed`. Every failure keeps
the previous entry, except `skipped-passthrough`, which hands the page to the
live handler.

A route that is not on-demand is not refused: the same call warms its runtime
caches instead (see "Warm any route before traffic"). An on-demand route gets
both: after the store write, the runner sends one warm request so the route's
loaders' own `cache()` and the document cache are rebuilt on the new entry.
That request needs a shared app cache store and an origin; without them the
refresh is complete as it is, and the result has no `caches`.

### Remove a page

A deleted product's page has to stop serving, and for a param the build baked,
the older build-time page must not come back in its place. So a removal does
not delete the entry: it stores a "removed" marker in the prerender store in
place of the page. There are two ways to write it.

```typescript
// 1. Explicitly, for example from a "product deleted" webhook. Nothing is
//    rendered, so it does not wait for the data source to catch up.
const prerender = router.prerender({ env, ctx });
await prerender.remove("/products/42");
await prerender.remove.many(paths, { concurrency: 4 });

// 2. By refreshing: a render that hits notFound() removes its own page.
export const ProductPage = Prerender(
  async () => [{ id: "featured" }],
  async (ctx) => {
    const product = await ctx.env.PRODUCTS.get(ctx.params.id);
    if (!product) notFound();
    return <Product data={product} />;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.id}`] } },
);
await prerender("/products/42"); // { ok: true, status: "removed", ... }
```

Both return `{ ok: true, path: "on-demand", status: "removed", key, tags }`.
The result is `ok: true`: a removal worked, so count `removed` in what a sweep
reports, next to `rendered` and `already-fresh`. From the next request on, the
route answers 404 for that param, in dev and in production; a `Passthrough`
route runs its live handler. A page the build baked is covered too: its
build-time entry is not served.

The two differ in how long they last:

|                          | `prerender.remove(url)`                    | a refresh that hits `notFound()`                                                   |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| renders                  | no                                         | yes                                                                                |
| the marker               | permanent: no `ttl`, no tags               | has the route's `ttl` and `tags`, like the page it replaces                        |
| `onRevalidate`           | never scheduled                            | scheduled by a request once the marker is stale; the 404 keeps answering meanwhile |
| `{ onlyIfStale: true }`  | leaves it and returns `removed`            | leaves it while fresh (`removed`); renders again once stale                        |
| `markStale(tags)`        | never reaches it                           | marks it stale through the route's tags, so it is rechecked                        |
| the page comes back when | a refresh without `onlyIfStale` renders it | the next recheck renders it, or any refresh does                                   |

- **A `notFound()` anywhere in the render removes the page**: in the route
  handler, a layout handler, a parallel slot handler, or any server component
  in the tree, sync or async. It removes it only when nothing else went wrong.
  When the data source may be failing, throw anything else: that is
  `render-failed` and keeps the page. A render that hits a `notFound()` and
  another error is `render-failed` too, whichever came first.
- **A `notFound()` removal is rechecked; `remove()` is permanent.** A data
  source that loses an item for a moment must not remove its page until the
  next deploy, so the marker of a refresh goes stale by the route's `ttl`
  (else the router's `prerender.ttl`; with neither it never does) and is
  rendered again by `onRevalidate` or a sweep, like a stale page. `remove()` is
  a decision, not an observation: its marker stays until a
  `prerender(url)` without `onlyIfStale` renders the page.
- **`ctx.passthrough()` in a refresh stores the marker too.** A `Passthrough`
  route whose build handler declines a param gets `skipped-passthrough`, and
  the live handler answers from then on, not a page stored or baked earlier.
  The marker is stamped and rechecked like a `notFound()` one.
- **`remove()` is for on-demand routes.** On any other route it returns
  `skipped-not-on-demand` and never warms. `no-match`, `no-store`,
  `skipped-unsupported-target` and `store-failed` are as for a refresh, and
  `throwOnError` works the same. `remove.many()` takes `concurrency` and
  `throwOnError`, and returns one result per target in input order.
- **Last write wins.** `remove()` and a refresh of the same page are two
  writes to one key. A job queued before a removal (an `onRevalidate` for the
  page when it was stale) that runs a plain refresh after it brings the page
  back: pass `{ onlyIfStale: true }` in `onRevalidate` and queue consumers, so
  they find the marker and render nothing. A marker that lands while a refresh
  is still rendering is not overwritten by that render's page; that narrows
  the race and cannot close it (the check and the write are two store calls,
  and KV is eventually consistent).
- **The marker does not reach the runtime caches around the route**, and no
  warm request follows a removal. A document cache
  (`createDocumentCacheMiddleware`) answers ahead of the router, so it keeps
  serving the document it stored until that entry's `s-maxage` and
  `stale-while-revalidate` run out. A `Passthrough` route's live handler serves
  through its own `cache()` as it does for a page that was never refreshed.
  Remove first, then invalidate:

  ```typescript
  path.json("/hooks/product-deleted", async (ctx) => {
    const { id } = (await ctx.request.json()) as { id: string };
    const result = await router
      .prerender({ env: ctx.env, ctx: ctx.executionContext })
      .remove(`/products/${id}`);
    await updateTag(`product:${id}`); // then drop the cached document
    return { status: result.status };
  });
  ```

  The order matters. With the invalidation first, a visitor between the two
  calls misses the document cache, is served the page the store still holds,
  and the document cache stores it again; the removal then cannot reach it.
  With the removal first, that visitor gets the document that is still
  cached, or, past the cache, the marker's 404, which is never stored: nothing
  can put the page back. `updateTag()` needs a request context: a webhook
  route has one, a
  queue or cron handler does not, and there the stored document serves until
  it expires. The cached document carries the tags its own request recorded
  (for example a `cacheTag()` call in middleware), not the route's
  `onDemand.tags`, which are prerender tags. A plain on-demand route's own
  `cache()` and its loaders' `cache()` need nothing: the request is a 404
  before any of them is shown.

- **A store that cannot be read is a miss**, for a marker as for a page: while
  the prerender store is failing, the build-time entry of a removed page can
  serve again.
- **The marker is per data version**, like every entry: a deploy that leaves
  the router's server code unchanged keeps it. After one that changes it the
  build decides again: a param `getParams()` still lists is baked and served.
  In dev every edit to a server module is such a change, so a marker (like a
  refreshed page) is gone after one.
- **Intercepted navigations do not see it.** They do not read the prerender
  store (see the rules below), so the build's intercept variant of a removed
  page still serves.

The `notFound()` half is the Next.js Pages Router's rule: "With
`notFound: true`, the page will return a `404` even if there was a
successfully generated page before. This is meant to support use cases like
user-generated content getting removed by its author. Note, `notFound`
follows the same `revalidate` behavior described here."
([getStaticProps](https://nextjs.org/docs/pages/api-reference/functions/get-static-props))

### What is served

| Request finds                     | `Prerender(..., { onDemand })`                              | `Passthrough(def, live)`                   |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| fresh overlay entry               | the overlay entry, loaders fresh (dev and production)       | same                                       |
| stale overlay entry               | the overlay entry; `onRevalidate` scheduled if configured   | same                                       |
| "removed" marker                  | **404** (dev and production); the build entry is not served | the live handler (dev and production)      |
| stale "removed" marker            | the same 404; `onRevalidate` scheduled if configured        | the live handler; `onRevalidate` likewise  |
| no overlay entry, param baked     | production: the build entry; dev: the dev prerender render  | same                                       |
| no overlay entry, param not baked | production: **404**; dev: rendered through the dev endpoint | the live handler (dev and production)      |
| server action re-render           | overlay, then build entry, then 404, as above               | the live handler (the overlay is not read) |

The retained handler never renders inside a production request: a plain
on-demand route 404s for a param until something refreshes it. Dev renders any
param through the dev prerender endpoint, so a production 404 does not show up
in dev. A removed page is the exception: its marker answers 404 in dev too.

### Rules worth knowing

- **`ttl` is soft staleness.** Entries never expire: a stale entry still serves
  (it is newer than the build entry below it) and only decides whether
  `onRevalidate` is scheduled. The KV store writes no `expirationTtl`.
- **`onRevalidate` runs once per stale key per isolate** while one is in
  flight, so calling `router.prerender()` from it renders once per stale key
  on a single Node process. Across isolates, dedup belongs to the queue. Its
  `target` is a `PrerenderTargetObject`, which the runner and its `.many()`
  accept as is, so
  `onRevalidate: (target, env, ctx) => router.prerender({ env, ctx })(target, { onlyIfStale: true })`
  typechecks without a cast. `onRevalidate` receives `(target, env, ctx)`;
  `ctx` is the stale request's execution context, absent where none exists.
  Pass `{ onlyIfStale: true }` wherever the refresh runs later than it was
  scheduled (here, and in a queue consumer): the entry is stale, so it
  renders, unless another job already refreshed it (`already-fresh`) or
  `prerender.remove()` removed the page in between (`removed`, nothing
  rendered). A refresh without it would bring a removed page back.
- **Prerender tags are their own namespace.** `cacheTag()`, `updateTag()` and
  `revalidateTag()` never reach the prerender store; the runner's `markStale()`
  never reaches the runtime cache. (`updateTag()` needs a request context;
  refreshes run from queues and crons.)
- **`markStale()` only marks.** The entry keeps serving; nothing re-renders
  unless `onRevalidate` is configured or a sweep calls
  `prerender(target, { onlyIfStale: true })`. Dev warns when you mark
  with no `onRevalidate`.
- **The producer is requestless.** `cookies()`, `headers()` and the client-cache
  directives make a refresh return `skipped-personalized`. `ctx.env` is the
  live env bound by `router.prerender({ env })`, not `buildEnv`, and `ctx.onDemand` is `true`.
- **A trigger may render params `getParams()` never returned.** Validate ids
  from webhooks before refreshing them.
- **A throw in a refresh keeps the old entry** (`render-failed`). A
  `notFound()` on its own is not a failure: it removes the page (see "Remove
  a page").
- **Intercepted navigations are not refreshed.** A refresh writes the main
  variant only; an intercept navigation still serves the build's intercept
  variant, and an on-demand route used as an intercept target 404s on a param
  that only a refresh produced.
- **Connected clients can lag.** A refresh has no response to reach open tabs:
  a client that prefetched the page keeps its copy for `prefetchCacheTTL`
  (default 300s) and the browser HTTP cache (`prefetchCacheControl`). Lower
  them if the window matters.
- **Entries are per deploy.** Keys carry the router's data version, so a deploy
  that changes server code starts from the build entries again; a client-only
  deploy keeps refreshed pages.

### Custom stores

A store is plain get/set; the router composes the envelope on write and
verifies it on read (version and params collision guard):

```typescript
import {
  serializePrerenderKey,
  type WritablePrerenderStore,
} from "@rangojs/router/prerender";

const store: WritablePrerenderStore = {
  async get(key) {
    const raw = await blob.get(serializePrerenderKey(key));
    return raw ? JSON.parse(raw) : null;
  },
  async set(key, stored) {
    await blob.put(serializePrerenderKey(key), JSON.stringify(stored));
  },
  // optional: delete(key), markStale(routerId, tags)
};
```

`markStale(routerId, tags)` receives the id of the router whose runner was
called (`key.routerId` on that router's entries). Mark only entries whose
`key.routerId` equals it: routers behind a host router share one store, and a
tag means something only inside the router whose routes declared it.

Key everything off the `key` you are given (`serializePrerenderKey` includes
`key.version`). Do not call `getCacheVersions()` in a prerender store: `set()`
runs outside the producer's request context.

`stored` is a page (`{ v, entry, meta }`) or the "removed" marker
(`{ v, removed: true, meta }`, no `entry`). A store that persists the JSON it
is given, like the one above, handles both and needs no change. `meta` has the
same fields on both, and means the same: a store that indexes by `meta.tags`
or lowers `meta.staleAt` for `markStale()` treats a marker as it treats a
page. That is how a `notFound()` marker is rechecked. A `remove()` marker has
no tags and no `staleAt`. Never drop or rewrite a value you do not
recognize: the router decides what it means. The router does not call
`delete(key)`; removing a page is a `set()` of the marker.

### Several routers (host router)

A runner belongs to the router `router.prerender()` was called on, so an app
with several routers behind a host router calls it on each router:

- It matches only that router's routes. A URL only another router has is
  `no-match`.
- Entries are keyed by router id plus that router's data version, so two
  routers can share one `prerender.store` (one KV namespace) without touching
  each other's entries. A deploy that changes one router's server code leaves
  the others' refreshed entries served when their code is separate (for
  example lazy mounts); routers that share a statically imported module move
  together.
- `markStale(tags)` marks only that router's entries, in every shipped store:
  `markStale(["product:1"])` on one router does not make another router's
  `product:1` entry stale.
- A warm of a non-on-demand route goes through that router's own handler, and
  its cache keys carry the host: pass the host the visitors use as `origin`
  (`router.prerender({ env, ctx, origin: "https://a.example" })`), or a path
  target resolves against the calling request's origin. A multi-router app
  passes `origin` or a full URL on every warm, so each router warms the host
  its visitors use. A warm that resolves another router's host stores the
  warming router's entries under that host; the router that owns the host
  never reads them (cache keys start with the router's id: `/host-router`,
  "Shared cache store").

### KV tag markers

`createKVPrerenderStore(kv)` writes a marker per tag at
`__rango_pr_tag__/{encodeURIComponent(routerId)}/{tag}` (the encoded router id)
and markers have no expiry: an entry without a `ttl` never goes stale by
itself, so an expired marker would silently drop an invalidation.

### Test it

`router.prerender()` and the serve path run under the public testing
primitives: render with `router.prerender()`, then `serveShellRequest(router,
url)` from `@rangojs/router/testing/flight` serves the route through the
production handler and returns the Flight payload. After
`prerender.remove(url)` the same request is a `404` (`result.response.status`).
`createMemoryPrerenderStore` is exported from `@rangojs/router/testing` too.
See `/testing`.

### loading() is ignored without Passthrough

Pre-rendered segments are fully resolved at build time and never suspend.
With `Passthrough()`, `loading()` works for live fallback renders.

## Warm any route before traffic

`router.prerender()` is one verb for "make this URL ready before a visitor
asks for it". For a `Prerender(..., { onDemand })` route that is the
requestless render above. For **every other route** it warms: the runner
sends the URL through the router's own request handler as an anonymous
visitor would, in a mode where every runtime cache read misses and every
write replaces the entry under the visitor's key. The old entries keep
serving until the new ones are written, so there is no cold window.

After a deploy that changes server code, and after an `updateTag()`, every
cache key starts cold and the first visitor per key pays the render. A warm
pays it for them.

```typescript
const prerender = router.prerender({
  env,
  ctx,
  origin: "https://shop.example",
});

await prerender("/products/1"); // any route
await prerender("/search?q=wine"); // search params are part of the key
await prerender.many(urls, { concurrency: 4 }); // default concurrency 1
await prerender.many(urls, { onlyIfStale: true }); // top up what is cold or stale
```

### What one call does

| Route                                         | `prerender(url)`                                                                                                            | `result.path` |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `Prerender(..., { onDemand })`                | requestless render into the prerender store; then a warm request, when the app cache store is shared and an origin resolves | `on-demand`   |
| any other route, shared app cache store       | a warm request through the router's handler                                                                                 | `warm`        |
| any other route, store not shared             | refused before anything renders: `skipped-store-not-shared` (dev warns once)                                                | `warm`        |
| any other route, no `createRouter({ cache })` | `no-store`                                                                                                                  | `warm`        |

A warm replaces what a cookie-free visitor's document request for that URL
would fill:

- a `ppr` route's shell (the next document request is `x-rango-shell: HIT`);
- the route's `cache()` records for a document request;
- the `"use cache"` results the render reaches (a function keyed by its
  arguments only is refreshed for every URL that calls it);
- its loaders' own `cache()`;
- the document cache entry (`createDocumentCacheMiddleware`), and a response
  route's cache.

It does not write the records a client navigation reads (`partial:`) or an
intercept's: those fill on the first navigation. A `ppr` route's navigations
replay the document shell, so they are covered.

A `clientUrls()` group cannot use `Prerender()`; with `ppr` on a group route,
warming is how that route is ready before its first visitor.

### The store must be shared

A warm fills the cache where the call runs. That helps other traffic only when
the store is shared beyond that place, so the router asks the store
(`SegmentCacheStore.scope`):

| Store                       | `scope`      | Warm                                                                                                                    |
| --------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `CFCacheStore` with `kv`    | `"global"`   | yes                                                                                                                     |
| `CFCacheStore` without `kv` | `"local"`    | refused: the Cache API is per colo                                                                                      |
| `VercelCacheStore`          | `"regional"` | yes; fills the region the call runs in (all traffic only on a single-region project)                                    |
| `MemorySegmentCacheStore`   | `"local"`    | refused in production; allowed under the dev server (one process serves every request); `{ scope: "global" }` admits it |
| a custom store              | its own      | only when it declares `scope: "global"` or `"regional"`; a store that declares none is refused                          |

`VercelCacheStore` is not checked for the number of regions: Vercel's Runtime
Cache is per region, and a warm fills the one it runs in. New projects and
every Hobby project run functions in one region (`iad1`); on a multi-region
project warm from each region, or accept that the others fill on first use.

The shared-store check covers the app store (`createRouter({ cache })`) only.
A warm also overwrites entries in a route's or loader's own `cache({ store })`,
and that store is not checked: one that is `local` is warmed for the calling
process only, so no other process or location sees the new entry.

The dev exception exists so you can try warming locally on the Node preset. It
follows the dev server, not `NODE_ENV`: a production build, `vite preview` and
a test runner all refuse the memory store. A single-process deployment whose
memory store really is the only copy says so with the `scope` option:

```typescript
const store = new MemorySegmentCacheStore({ scope: "global" });
```

It is not the default because the store is per process and the router cannot
tell one long-running server from several replicas or serverless instances. A
default of `"global"` would report `warmed` while most visitors hit a cold
instance, so you opt in only when exactly one process serves the app. Two
instances with the same `name` share their maps but each declares its own
`scope`: keep them identical.

### The origin

Cache keys carry the host, so a warm must request the host visitors use. In
order:

1. the target's own origin (`prerender("https://shop.example/p/1")`, or a
   `URL`);
2. `origin` on the binding (`router.prerender({ env, ctx, origin })`), for
   path and `{ route, params }` targets;
3. the origin of the request the runner is called from, when there is one: a
   server action, a route handler, `onRevalidate`;
4. none: `skipped-no-origin`.

A cron or queue handler has no request, so give it `origin`. An on-demand
render never needs one (prerender keys carry no host); without one it only
skips the warm request that follows.

A hash, or a parameter the router reserves (`_rsc*`, `__no_cache`), is
`skipped-unsupported-target`.

### The request is anonymous

The warm is a `GET` with `accept: text/html` and nothing else: no cookies, no
authorization, no user agent, no `accept-language`, and on Cloudflare no
`request.cf`. It lands in the partition a header-less visitor lands in (a
route partitioned by `cache({ key })` or the store's `keyGenerator` gets that
one partition warmed).

- Middleware runs and sees an anonymous request. An auth middleware that
  redirects makes the result `render-failed` with `responseStatus: 302`: an
  anonymous visitor is not served a cached page there either.
- `cookies()` or `headers()` read outside any cached scope see nothing, and
  the anonymous view is rendered and stored wherever a cookie-free visitor's
  would be.
- A read inside `cache()`, `"use cache"` or a `ppr` shell capture trips the
  same guard it trips for a visitor; the result is `skipped-personalized`.
- Analytics that count document GETs count warms, and a rate limiter keyed by
  IP sees an empty key.

Nothing a client sends makes a request a warm: the mark is in process.

### Results

```typescript
const result = await prerender("/products/1");
if (!result.ok) console.warn(result.status, result.caches);
```

| `status`                     | `ok`    | Meaning                                                                                         |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `warmed`                     | `true`  | the request rendered and at least one cache wrote                                               |
| `already-fresh`              | `true`  | `onlyIfStale`: nothing was cold or stale                                                        |
| `skipped-store-not-shared`   | `false` | the app store's `scope` is `"local"` or undeclared; nothing rendered                            |
| `skipped-no-origin`          | `false` | a path target with no origin to request it on                                                   |
| `no-store`                   | `false` | no `createRouter({ cache })`, or `enabled: false`                                               |
| `skipped-personalized`       | `false` | an identity guard refused a read                                                                |
| `shell-not-stored`           | `false` | a `ppr` route whose shell was not stored; `caches.shell` and `caches.refusal` say why           |
| `skipped-uncached`           | `false` | the request rendered and no cache wrote (the route caches nothing, or every write was refused)  |
| `render-failed`              | `false` | the handler threw, the response was not 200 (`responseStatus`), or the render reported an error |
| `skipped-unsupported-target` | `false` | a hash or a reserved parameter                                                                  |
| `no-match`                   | `false` | no route matches the path                                                                       |

`result.target` is the absolute URL that was requested. `result.caches` has
the detail: `writes` by store family (`record`, `item`, `response`, `shell`),
`shell` (`stored`, `fresh`, `refused`, `no-shell`, `not-eligible`,
`skipped-capacity`, `skipped-queue-timeout`, `error`), `refusal` when the
capture refused, and `document` (`stored` or `not-cacheable`) when the document
cache middleware ran. `throwOnError: true` throws a `PrerenderError` on any
`ok: false`, refusals included.

`.many()` dispatches each target on its own, so a batch can mix on-demand and
plain routes: one result per target, in input order.

`onlyIfStale` on a plain route makes the request read its caches normally
instead of forcing misses: a fresh entry is left alone, a stale one refreshes,
a missing one is written. It costs a visitor's request when everything is
fresh.

### Refreshing changed content: `updateTag`, then `prerender`

A warm replaces the entry where it runs, and on a shared store that is the
entry other locations read on their next miss. It does not reach a copy
another location already holds: on `CFCacheStore`, each colo keeps serving its
own Cache API copy until it expires, and an entry whose `ttl + swr` is under
60 seconds never reaches KV at all.

So after a deploy (new keys: no location holds a copy) a warm alone makes
the route ready everywhere. For a content change, invalidate first, then
warm:

```typescript
// A CMS webhook route. A webhook is a request, so updateTag() works here and
// the warm takes the request's origin.
path.json("/hooks/product-changed", async (ctx) => {
  const { id } = (await ctx.request.json()) as { id: string };
  await updateTag(`product:${id}`); // drops every location's copy
  const result = await router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  })(`/products/${id}`); // writes the new one
  return { status: result.status };
});
```

The invalidation makes every location's copy unservable, so no visitor is
served the old content, and the warm writes the new entry where it runs and
to the shared store. A location with no copy of its own reads that entry on
its next request and renders nothing. On `CFCacheStore`, a colo that was
still holding its own (now invalidated) copy renders once for itself instead
of reading the warmed entry, unless the store uses `tagPurge`, which evicts
those copies. Await `updateTag()` before the warm: a write that started
before an invalidation of one of its tags is refused.

### Limits worth knowing

- **Only the router's own handler.** A warm goes through `router.fetch`, the
  handler `createRouter`'s `cache`, `nonce` and `version` configure. An app
  entry that builds its own `createRSCHandler({ cache, version })` is not what
  a warm runs: put those options on `createRouter`.
- **Document records only.** Navigation (`partial:`) and intercept records
  fill on the first navigation.
- **One location at a time.** A warm does not reach a copy another location
  already holds; see the refresh pattern above.
- **A warm costs a visitor's MISS:** one render, plus a shell capture on a
  `ppr` route. `concurrency` defaults to 1 so a sweep never fans out against
  your data source unless you ask. One call waits for the request's
  background work (the cache writes, the capture), up to about 40 seconds in
  the worst case; a large list belongs in a queue, one message per batch.
- **Gradual deployments:** a warm fills the version that received the call.
- **The correctness guards still decide.** A warm never stores what a
  visitor's request would refuse to store: `cache(false)`, a false
  `condition()`, `private` / `no-store` / `Set-Cookie` on a document, a tag
  invalidated mid-render, an entry over the store's size limit.

### Test it

`router.prerender()` warms under the public testing primitives too: warm, then
`serveShellRequest(router, url)` from `@rangojs/router/testing/flight` serves
the next visitor's request through the production handler (`shellStatus:
"HIT"`). Configure the store on the router (`createRouter({ cache: { store }
})`), not through `serveShellRequest`'s `cacheStore` option, and give it a
shared scope: the shipped `MemorySegmentCacheStore` is refused, so pass
`{ scope: "global" }` as above. See `/testing`.

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

The `when` config selector receives an `InterceptSelectorContext` whose `from`
location (the page being left) is unknown at build time. All intercepts are pre-rendered unconditionally;
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
    { when: ({ from }) => from.url.pathname === "/shop" },
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
- `od: true` -- route opted into on-demand refresh (`onDemand`); the writable
  store is read before the build manifest

At runtime, the cache-lookup middleware uses these flags:

- `od + overlay hit` -- serve the on-demand entry
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
- `/cloudflare` — the KV-backed on-demand store and a queue consumer
- `/loader` — loaders stay live on prerendered routes
