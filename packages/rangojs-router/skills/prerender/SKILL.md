---
name: prerender
description: Pre-render route segments at build time with Prerender and passthrough fallback
argument-hint: [passthrough]
---

# Pre-rendering with Prerender

Pre-rendering is **caching at build time**. Same serialization format, same
deserialization path, same segment system. The worker handles every request --
there are NO static .html or .rsc files served from assets. The worker reads
pre-computed Flight payloads instead of executing handler code.

Canonical semantics reference:
[docs/execution-model.md](../../docs/internal/execution-model.md)

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

```typescript
export const ProductPage = Prerender(
  async () => {
    const top = await db.query("SELECT id FROM products WHERE featured");
    return top.map(p => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.query("SELECT * FROM products WHERE id = ?", ctx.params.id);
    return <Product data={product} />;
  },
  { passthrough: true, concurrency: 4 }
);
```

## Passthrough Mode

Controls whether the handler stays in the RSC server bundle after build:

|                     | `passthrough: false` (default)          | `passthrough: true`                     |
| ------------------- | --------------------------------------- | --------------------------------------- |
| Known params        | Served from pre-rendered Flight payload | Served from pre-rendered Flight payload |
| Unknown params      | Handler evicted, no live fallback       | Handler runs live at request time       |
| `ctx.passthrough()` | Throws (not allowed)                    | Skips artifact, defers to live fallback |
| Bundle size         | Handler code + imports removed          | Handler code kept in RSC bundle         |
| `revalidate()`      | Not allowed (handler gone)              | Allowed (handler can re-render)         |
| `loading()`         | Ignored (segments fully resolved)       | Works for live fallback renders         |

### When to use passthrough

Use `passthrough: true` when:

- The route has a large or open-ended param space (e.g., user profiles, product pages)
- You want to pre-render popular/known params for speed but still serve unknown params live
- You need `revalidate()` on the route

Use `passthrough: false` (default) when:

- All possible params are known at build time (e.g., markdown files, config-driven pages)
- You want maximum bundle size reduction (handler code + node:fs imports removed)
- The route uses build-only APIs (node:fs, local files) not available at runtime

## BuildContext

Handlers receive `BuildContext` at build time, a subset of the runtime `HandlerContext`:

```typescript
interface BuildContext<TParams> {
  params: TParams; // From getParams
  build: true; // Always true at build time
  use: <T>(handle: Handle<T>) => (data: T) => void; // Push handle data
  url: URL; // Synthetic URL from pattern + params
  pathname: string; // Pathname from synthetic URL
  set(key: string, value: any): void; // Set context variable (string key)
  set<T>(contextVar: ContextVar<T>, value: T): void; // Set typed context variable
  get(key: string): any; // Read context variable (string key)
  get<T>(contextVar: ContextVar<T>): T | undefined; // Read typed context variable
  reverse(
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ): string; // URL generation
  passthrough(): PrerenderPassthroughResult; // Skip local artifact (passthrough routes only)
  // NOT available: req, headers, cookies, env (throws descriptive errors)
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

// Stubbed (ships to server bundle when passthrough: false)
export const BlogPost = {
  __brand: "prerenderHandler",
  $$id: "abc123#BlogPost",
};
```

The original module and its imports (node:fs, markdown libs) are excluded from
the bundle. With `passthrough: true`, the handler code stays in the RSC bundle.

In client and SSR environments, ALL prerender handlers are always stubbed
(passthrough only affects the RSC server bundle).

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

| DSL item       | Behavior with Prerender                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loader()`     | Live at runtime, bundled normally. Use `cache()` for caching.                                                                                                                                                                                                       |
| `revalidate()` | Not allowed without passthrough. Allowed with passthrough.                                                                                                                                                                                                          |
| `cache()`      | Orthogonal -- use on parent layouts and loaders.                                                                                                                                                                                                                    |
| `layout()`     | Child layouts inside path are pre-rendered. Parent layouts are live.                                                                                                                                                                                                |
| `parallel()`   | Parallel slots inside path are pre-rendered.                                                                                                                                                                                                                        |
| `middleware()` | Skipped during pre-render (no request). Runs at request time for loaders.                                                                                                                                                                                           |
| `loading()`    | Ignored without passthrough. Works for live fallback with passthrough.                                                                                                                                                                                              |
| `intercept()`  | Pre-rendered at build time. Intercept variant stored under `/i` key alongside main segments. At runtime, the correct variant is served based on `ctx.isIntercept`. `when()` conditions are skipped at build time (all intercepts are pre-rendered unconditionally). |

When passthrough revalidation is enabled, remember that revalidation is
still partial: opting a child segment into revalidation does not
implicitly re-run outer prerender-derived handlers/layouts.

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
  { passthrough: true },
);
```

Skipped entries are excluded from the build output. With `passthrough: true`,
the handler stays in the bundle and serves skipped params live at request time.

`Skip` also works in `Static` handlers:

```typescript
import { Static, Skip } from "@rangojs/router";

export const TocSidebar = Static(() => {
  throw new Skip("Not ready for pre-rendering");
});
```

### Error behavior at build time

| Handler outcome             | Effect                                                |
| --------------------------- | ----------------------------------------------------- |
| JSX / `null`                | Normal prerender entry, log OK                        |
| `return ctx.passthrough()`  | Skip entry, log PASS, continue (passthrough routes)   |
| `throw new Skip("reason")`  | Skip entry, log SKIP, continue with remaining entries |
| `throw new Error("reason")` | Log FAIL, stop ALL pre-rendering, fail the build      |

Both error types propagate to the router's `onError` callback with phase
`"prerender"` or `"static"`.

### Build logs

The build produces per-URL timing logs:

```
[rsc-router] Pre-rendering 12 URL(s) (concurrency: 4)...
[rsc-router]   OK   /articles/hello            (42ms)
[rsc-router]   PASS /articles/remote-only      (5ms) - live fallback
[rsc-router]   SKIP /articles/draft-post       (3ms) - Article is a draft
[rsc-router] Pre-render complete: 11 done, 1 skipped (1204ms total)

[rsc-router] Rendering 3 static handler(s)...
[rsc-router]   OK   DocsLayout                 (28ms)
[rsc-router]   SKIP TocSidebar                 (1ms) - Not ready
[rsc-router] Static render complete: 2 done, 1 skipped (120ms total)
```

A `FAIL` line is logged per-URL when a handler throws a non-Skip error. The
error is re-thrown immediately, so no summary line is printed — the build
stops at the first failure.

### Dev mode behavior

**Node.js dev server** — `Skip` behaves like a regular runtime error because
the handler runs live with `ctx.build === false`.

**Non-Node runtimes using `/__rsc_prerender`** — `Skip` participates in the
on-demand prerender path, so build-style skip logic does run for that request.
The dev prerender endpoint treats it like a prerender miss and the request
falls back according to normal dev/runtime behavior.

## Per-Param Passthrough with ctx.passthrough()

On `{ passthrough: true }` routes, a handler can return `ctx.passthrough()`
to skip writing a local prerender artifact for a specific param set. At
runtime, the missing entry falls through to the live handler.

```typescript
export const BlogPost = Prerender(
  async () => [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  async (ctx) => {
    const post = await getPost(ctx.params.slug);
    if (!post) return ctx.passthrough();
    return <article>{post.content}</article>;
  },
  { passthrough: true },
);
```

### Semantics

- JSX or `null` from the handler produces a normal prerender entry.
- `ctx.passthrough()` returns a sentinel that signals "no local artifact".
  The build skips the manifest entry for that param set.
- `ctx.passthrough()` on a non-passthrough route throws an invariant error.
- `ctx.passthrough()` at runtime (`ctx.build === false`) also throws.
  It is a build-time-only control flow.
- `getParams()` still enumerates the param set; the handler decides per-param
  whether to produce an artifact or defer to runtime.

### Difference from Skip

| Mechanism           | Effect on build        | Runtime behavior                                     |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| `throw new Skip()`  | Skips entry, logs SKIP | No artifact, no live fallback unless passthrough     |
| `ctx.passthrough()` | Skips entry, logs PASS | Always defers to live handler (requires passthrough) |

Use `ctx.passthrough()` when you want the handler to run live at request time
for specific params. Use `Skip` when you want to exclude params entirely.

### Use case: Remote storage

`ctx.passthrough()` enables a pattern where build-time data is stored in a
remote KV store instead of the local prerender manifest. The handler
pre-computes data during `getParams`, pushes it to KV, then calls
`ctx.passthrough()` so the local build skips the artifact. At runtime,
the live handler reads from KV:

```typescript
export const Product = Prerender(
  async () => {
    const products = await db.getFeaturedProducts();
    // Pre-compute and store in remote KV during build
    for (const p of products) {
      await kv.put(`product:${p.id}`, await renderProduct(p));
    }
    return products.map(p => ({ id: p.id }));
  },
  async (ctx) => {
    // At build time: skip local artifact, data is in KV
    if (ctx.build) return ctx.passthrough();
    // At runtime: read from KV
    const cached = await kv.get(`product:${ctx.params.id}`);
    if (cached) return cached;
    return <Product data={await db.getProduct(ctx.params.id)} />;
  },
  { passthrough: true },
);
```

### Build logs

Passthrough entries are logged distinctly:

```
[rsc-router]   OK   /blog/a                          (42ms)
[rsc-router]   PASS /blog/b                          (3ms) - live fallback
[rsc-router]   OK   /blog/c                          (38ms)
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
frozen. Loaders are live and can be revalidated by actions. With `passthrough: true`
and `revalidate()`, the handler itself can re-render live.

### Empty getParams

If `getParams` returns an empty array, no Flight payloads are written. No error.

### Route name is required

Routes using `Prerender` must have a `name` in path options.
The name is used as the storage key for Flight payloads.

### No revalidate without passthrough

Using `revalidate()` with `passthrough: false` produces a build-time warning.
The handler is evicted -- there is nothing to re-render.

### loading() is ignored without passthrough

Pre-rendered segments are fully resolved at build time and never suspend.
With `passthrough: true`, `loading()` works for live fallback renders.

## Complete Example

```typescript
// pages/guides-handler.tsx
import { Prerender } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { href } from "../router.js";

const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
};

export const GuidesDetail = Prerender<{ slug: string }>(
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
  { passthrough: true },
);

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
  intercept-resolution middleware runs live. This handles `when()` conditions
  that prevented pre-rendering.

The `when()` callback receives an `InterceptSelectorContext` with `from.pathname`
which is unknown at build time. All intercepts are pre-rendered unconditionally;
`when()` is evaluated at runtime by the intercept-resolution middleware.

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
  intercept("@modal", ".detail", <ProductModal />, () => [
    when(({ from }) => from.pathname === "/shop"),
    loader(ProductLoader),
  ]),
])
```

Both `ProductPage` (main) and `ProductModal` (intercept) are frozen at build time.
Loaders run fresh at request time for both variants.

## Trie Flags

Pre-rendered routes set flags on the route trie leaf at build time:

- `pr: true` -- route has pre-rendered B segment data
- `pt: true` -- passthrough mode (handler available for live fallback)

At runtime, the cache-lookup middleware uses these flags:

- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to live handler (handler kept in bundle)
- `pr + miss` (no pt) -- fall through (handler stubbed, no live render)

## Contributor Checklist

Before changing prerender behavior, read these docs and run these tests.

### Docs to re-read

- [Prerender API design](../../docs/prerender-api-design.md) -- canonical
  architecture: build-time flow, runtime flow, storage, passthrough, intercept
- [Execution model](../../docs/internal/execution-model.md) -- handler-first
  ordering, middleware scope, context visibility rules
- [Semantic change checklist](../../docs/internal/semantic-change-checklist.md)
  -- gate for any change to execution semantics

### Tests to run

```bash
# Core prerender e2e (passthrough, eviction, loaders, sub-use, intercept)
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
- Behavioral assertions (rendered content, loader freshness, passthrough
  fallback, intercept variant selection) must work in the production build.

## Maintenance References

- [Stability next steps plan](../../docs/internal/stability-next-steps-plan.md)
  -- completed parity and cleanup pass (reference for decisions made)
- [Test quality baseline](../../docs/internal/test-quality-baseline.md) --
  measured test inventory, sleep debt, production coverage gaps
