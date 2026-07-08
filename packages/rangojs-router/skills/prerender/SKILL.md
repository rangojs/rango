---
name: prerender
description: Pre-render route segments at build time with Prerender and Passthrough live fallback. Use when a page's content is mostly static and shouldn't render on every request, speeding up cold responses, or deciding which routes to prerender vs render live.
argument-hint: [passthrough]
---

# Pre-rendering with Prerender

Pre-rendering is **caching at build time**. Same serialization format, same
deserialization path, same segment system. The worker handles every request --
there are NO static .html or .rsc files served from assets. The worker reads
pre-computed Flight payloads instead of executing handler code.

## Not this skill if…

- You want a cached HTML shell captured at runtime, with holes and loaders
  staying live per request — see `/ppr`.
- You want runtime segment caching with TTL/SWR — that is the `cache()` DSL:
  see `/caching`. Prerender is the same cache filled at build time.

## API: Prerender

### Static Route (no params)

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
| `revalidate()`      | Not allowed (handler gone)              | Allowed (live handler can re-render)     |
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
  dynamic(): void; // No-op in Prerender/Static handlers; use middleware for PPR shell opt-out
  env: DefaultEnv; // Available when buildEnv is configured in rango() (throws otherwise)
  // NOT available: request, headers, cookies (always throw)
}
```

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

Everything inside the path's use() callback is part of the B segment and gets
pre-rendered:

```typescript
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  layout(<PostLayout />, () => [        // inside B -> pre-rendered
    loader(PostMetaLoader),              // live at runtime, bundled normally
  ]),
  parallel({ "@sidebar": BlogSidebar }), // inside B -> pre-rendered
])
```

If a parallel or child layout uses node APIs, wrap it in `Prerender`
(static, no getParams) so the Vite plugin can stub it:

```typescript
// sidebar.tsx -- uses node:fs, must be a Prerender
export const BlogSidebar = Prerender(async (ctx) => {
  const files = await fs.readdir("content/blog/");
  return <Sidebar posts={files.map(f => basename(f, ".md"))} />;
});

// urls.tsx
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  parallel({ "@sidebar": BlogSidebar }),  // stubbable, node:fs excluded
])
```

## Interaction with DSL Items

| DSL item       | Behavior with Prerender                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loader()`     | Live at runtime, bundled normally. Use `cache()` for caching.                                                                                                                                                                                                            |
| `revalidate()` | Not allowed without Passthrough. Allowed with Passthrough.                                                                                                                                                                                                               |
| `cache()`      | Orthogonal -- use on parent layouts and loaders.                                                                                                                                                                                                                         |
| `layout()`     | Child layouts inside path are pre-rendered. Parent layouts are live.                                                                                                                                                                                                     |
| `parallel()`   | Parallel slots inside path are pre-rendered.                                                                                                                                                                                                                             |
| `middleware()` | Skipped while collecting build-time Flight payloads (no request). For `Prerender` + `ppr`, producer B replays global and route middleware during build-shell capture with `ctx.build === true`; `ctx.dynamic()` skips that shell. Runs at request time for loaders.      |
| `loading()`    | Ignored without Passthrough. Works for live fallback with Passthrough.                                                                                                                                                                                                   |
| `intercept()`  | Pre-rendered at build time. Intercept variant stored under `/i` key alongside main segments. At runtime, the correct variant is served based on `ctx.isIntercept`. `when` config conditions are skipped at build time (all intercepts are pre-rendered unconditionally). |

When Passthrough revalidation is enabled, remember that revalidation is
still partial: opting a child segment into revalidation does not
implicitly re-run outer prerender-derived handlers/layouts.

## Prerender + PPR Build Shells

A `Prerender` page may also declare `ppr` on the path option. The build still
stores the Flight payload first. After that, producer B tries to bake the HTML
shell for each generated URL so the first document request can be an
`x-rango-shell: HIT`.

That shell capture is request-shaped enough to run middleware safely:

- global and route middleware run before shell capture;
- middleware sees `ctx.build === true`;
- `ctx.waitUntil()` is inert during build;
- `ctx.dynamic()` skips the baked shell for that URL.

Use `ctx.build` inside middleware to avoid runtime-only side effects during
build shell capture, or call `ctx.dynamic()` to leave that route to runtime
PPR. Runtime requests still run the normal middleware chain.

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
serves the build-baked B-segments — fresh loaders in their holes, not a fresh
handler render. There is no "fully dynamic" render for a prerendered route.

## Dev Mode

In dev mode there is no production-style prerender build pass and no handler
stubbing.

**Node.js dev server** — `Prerender` acts as a normal handler. Routes render
live on every request with full runtime context (`ctx.build === false`).

**Non-Node runtimes (Cloudflare workerd, Deno workers)** — Handlers that
depend on Node APIs (e.g. `node:fs`) cannot run in-process. The Vite plugin
can intercept these requests and resolve them via the `/__rsc_prerender`
endpoint, which runs `matchForPrerender` in a Node.js temp server. In this
path the handler receives `BuildContext` (`ctx.build === true`) and segments
are resolved identically to production prerendering, then served on-demand.
This only applies when `__PRERENDER_DEV_URL` is set by the plugin.

## Storage Layout

Pre-rendered Flight payloads are stored in the build output:

```
dist/static/__<hash>/
  prerender/
    blog.post/
      d4e5f6a7.flight    # hash of { slug: "hello-world" }
      b8c9d0e1.flight    # hash of { slug: "getting-started" }
    about/
      _.flight            # static route, no params
```

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

// Wrap with Passthrough to serve skipped params live at runtime
export const BlogPost = Passthrough(BlogPostDef, async (ctx) => {
  if (ctx.params.slug === "draft") {
    throw new Skip("Draft articles are not pre-rendered");
  }
  return <PostPage slug={ctx.params.slug} />;
});
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

With `"warn"` the errored entry is logged and left un-baked (never served as a baked
200 error page). `"warn"` is a build-unblock, not a runtime contract: the route falls
through to normal resolution — it may render live (its handler is still bundled) or
404 (once other baked entries trigger prerender handler eviction), so the outcome
depends on the rest of the build, and a skipped `Static()` handler's evicted code can
surface as an error. For DEFINED runtime behavior reach for `Passthrough()` (a live
fallback) or `throw new Skip()` (an intentional skip — works in the render fn, not
only `getParams()`); otherwise prefer the default `"fail"`.

Both `Skip` and hard errors propagate to the router's `onError` callback with phase
`"prerender"` or `"static"`.

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

**Node.js dev server** — `Skip` behaves like a regular runtime error because
the handler runs live with `ctx.build === false`.

**Non-Node runtimes using `/__rsc_prerender`** — `Skip` participates in the
on-demand prerender path, so build-style skip logic does run for that request.
The dev prerender endpoint treats it like a prerender miss and the request
falls back according to normal dev/runtime behavior.

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

### Handle data is frozen

Handle values pushed via `ctx.use()` during pre-rendering are baked into the
Flight payload. They do not update at request time.

### Server actions work normally

Actions do not re-render the B segment. The pre-rendered handler output stays
frozen. Loaders are live and can be revalidated by actions. With `Passthrough()`
and `revalidate()`, the live handler can re-render.

### Empty getParams

If `getParams` returns an empty array, no Flight payloads are written. No error.

### Route name is required

Routes using `Prerender` must have a `name` in path options.
The name is used as the storage key for Flight payloads.

### No revalidate without Passthrough

Using `revalidate()` without `Passthrough()` produces a build-time warning.
The handler is evicted -- there is nothing to re-render.

### loading() is ignored without Passthrough

Pre-rendered segments are fully resolved at build time and never suspend.
With `Passthrough()`, `loading()` works for live fallback renders.

## Complete Example

```typescript
// pages/guides-handler.tsx
import { Prerender, Passthrough } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { href } from "../router.js";

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
          <Link to={href("guides.detail", { slug: "routing" })}>Routing</Link>
          {" | "}
          <Link to={href("guides.detail", { slug: "dynamic-test" })}>Dynamic</Link>
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
        <Link to={href("guides.detail", { slug: "routing" })}>Routing</Link>
        {" | "}
        <Link to={href("guides.detail", { slug: "dynamic-test" })}>Dynamic</Link>
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

- `pr: true` -- route has pre-rendered B segment data
- `pt: true` -- route wrapped with `Passthrough()` (live handler available)

At runtime, the cache-lookup middleware uses these flags:

- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to Passthrough live handler
- `pr + miss` (no pt) -- fall through (handler stubbed, no live render)

## Contributor Checklist

Before changing prerender behavior, run these tests.

### Tests to run

```bash
# Core prerender e2e (Passthrough, eviction, loaders, sub-use, intercept)
pnpm --filter @rangojs/router exec playwright test prerender

# Prerender-specific unit test
pnpm --filter @rangojs/router run test:unit -- prerender-passthrough

# Semantic matrix (prerender rows cover intercept + ctx propagation)
pnpm --filter @rangojs/router exec playwright test semantic-matrix

# Handler-first (ctx.set/get visibility with prerender handlers)
pnpm --filter @rangojs/router exec playwright test handler-first
```

### Dev-only vs build-parity

- Prerender e2e tests run against a real production build by default (the
  fixture builds the test app). Dev-mode prerender behavior is tested via
  `/__rsc_prerender` endpoint tests and node.js dev-server fallback.
- Log-based assertions (build output lines, debug cache logs) are inherently
  dev/build-only and do not need a production counterpart.
- Behavioral assertions (rendered content, loader freshness, Passthrough
  fallback, intercept variant selection) must work in the production build.
