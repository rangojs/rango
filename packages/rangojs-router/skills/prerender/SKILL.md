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

|                | `passthrough: false` (default)          | `passthrough: true`                     |
| -------------- | --------------------------------------- | --------------------------------------- |
| Known params   | Served from pre-rendered Flight payload | Served from pre-rendered Flight payload |
| Unknown params | Handler evicted, no live fallback       | Handler runs live at request time       |
| Bundle size    | Handler code + imports removed          | Handler code kept in RSC bundle         |
| `revalidate()` | Not allowed (handler gone)              | Allowed (handler can re-render)         |
| `loading()`    | Ignored (segments fully resolved)       | Works for live fallback renders         |

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
  use: <T>(handle: Handle<T>) => (data: T) => void; // Push handle data
  url: URL; // Synthetic URL from pattern + params
  pathname: string; // Pathname from synthetic URL
  set(key: string, value: any): void; // Set context variable (string key)
  set<T>(contextVar: ContextVar<T>, value: T): void; // Set typed context variable
  get(key: string): any; // Read context variable (string key)
  get<T>(contextVar: ContextVar<T>): T | undefined; // Read typed context variable
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

In dev mode, `Prerender` is a normal handler. Routes render live
on every request. No stubbing, no build-time pre-rendering. The handler runs
with full runtime context (not BuildContext).

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

| Throw type                  | Effect                                                |
| --------------------------- | ----------------------------------------------------- |
| `throw new Skip("reason")`  | Skip entry, log SKIP, continue with remaining entries |
| `throw new Error("reason")` | Log FAIL, stop ALL pre-rendering, fail the build      |

Both error types propagate to the router's `onError` callback with phase
`"prerender"` or `"static"`.

### Build logs

The build produces per-URL timing logs:

```
[rsc-router] Pre-rendering 12 URL(s) (concurrency: 4)...
[rsc-router]   OK   /articles/hello            (42ms)
[rsc-router]   SKIP /articles/draft-post       (3ms) - Article is a draft
[rsc-router]   FAIL /articles/broken           (15ms) - DB connection refused
[rsc-router] Pre-render complete: 10 ok, 1 skipped, 1 failed (1204ms total)

[rsc-router] Rendering 3 static handler(s)...
[rsc-router]   OK   DocsLayout                 (28ms)
[rsc-router]   SKIP TocSidebar                 (1ms) - Not ready
[rsc-router] Static render complete: 2 ok, 1 skipped (120ms total)
```

### Dev mode behavior

In dev mode, `Skip` is a regular Error. Throwing it in a handler will surface
as a runtime error (no build-time skip logic exists in dev). This matches the
general dev-mode principle where Prerender handlers run live per request.

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
import { urls, include } from "@rangojs/router";
import { guidesPatterns } from "./pages/guides.js";

export const urlpatterns = urls(({ path }) => [
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
