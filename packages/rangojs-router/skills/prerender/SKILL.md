---
name: prerender
description: Pre-render route segments at build time with createPrerenderHandler and passthrough fallback
argument-hint: [passthrough]
---

# Pre-rendering with createPrerenderHandler

Pre-rendering is **caching at build time**. Same serialization format, same
deserialization path, same segment system. The worker handles every request --
there are NO static .html or .rsc files served from assets. The worker reads
pre-computed Flight payloads instead of executing handler code.

## API: createPrerenderHandler

### Static Route (no params)

```typescript
import { createPrerenderHandler } from "@rangojs/router";

export const AboutPage = createPrerenderHandler(async (ctx) => {
  const content = await fs.readFile("content/about.md", "utf-8");
  return <Page content={markdownToJsx(content)} />;
});

// urls.tsx
path("/about", AboutPage, { name: "about" })
```

### Dynamic Route (with params)

Params come first, handler second:

```typescript
export const BlogPost = createPrerenderHandler(
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
```

## Passthrough Mode

Controls whether the handler stays in the RSC server bundle after build:

| | `passthrough: false` (default) | `passthrough: true` |
|---|---|---|
| Known params | Served from pre-rendered Flight payload | Served from pre-rendered Flight payload |
| Unknown params | Handler evicted, no live fallback | Handler runs live at request time |
| Bundle size | Handler code + imports removed | Handler code kept in RSC bundle |
| `revalidate()` | Not allowed (handler gone) | Allowed (handler can re-render) |
| `loading()` | Ignored (segments fully resolved) | Works for live fallback renders |

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
  params: TParams;           // From getParams
  use: <T>(handle: Handle<T>) => (data: T) => void;  // Push handle data
  url: URL;                  // Synthetic URL from pattern + params
  pathname: string;          // Pathname from synthetic URL
  // NOT available: req, headers, cookies, env (throws descriptive errors)
}
```

All items inside the path's use() callback (child layouts, parallels) also receive
`BuildContext` during pre-rendering. Loaders are the exception -- they run at
request time with full server context.

## Supported Export Patterns

All of the following are equivalent and fully supported by the Vite transform:

```typescript
// Direct export (most common)
export const BlogPost = createPrerenderHandler(getParams, handler);

// Separate declaration + named export
const BlogPost = createPrerenderHandler(getParams, handler);
export { BlogPost };

// Aliased export
const InternalPage = createPrerenderHandler(getParams, handler);
export { InternalPage as BlogPost };

// Aliased import
import { createPrerenderHandler as cph } from "@rangojs/router";
export const BlogPost = cph(getParams, handler);
```

All patterns support whole-file stubbing, expression stubbing, and build-time
module tracking. The same applies to `createStaticHandler`.

## Handler Eviction

In production builds, `createPrerenderHandler` exports are replaced with stubs:

```typescript
// Original
export const BlogPost = createPrerenderHandler(getParams, handler);

// Stubbed (ships to server bundle when passthrough: false)
export const BlogPost = { __brand: "prerenderHandler", $$id: "abc123#BlogPost" };
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

If a parallel or child layout uses node APIs, wrap it in `createPrerenderHandler`
(static, no getParams) so the Vite plugin can stub it:

```typescript
// sidebar.tsx -- uses node:fs, must be a createPrerenderHandler
export const BlogSidebar = createPrerenderHandler(async (ctx) => {
  const files = await fs.readdir("content/blog/");
  return <Sidebar posts={files.map(f => basename(f, ".md"))} />;
});

// urls.tsx
path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
  parallel({ "@sidebar": BlogSidebar }),  // stubbable, node:fs excluded
])
```

## Interaction with DSL Items

| DSL item       | Behavior with createPrerenderHandler |
|----------------|--------------------------------------|
| `loader()`     | Live at runtime, bundled normally. Use `cache()` for caching. |
| `revalidate()` | Not allowed without passthrough. Allowed with passthrough. |
| `cache()`      | Orthogonal -- use on parent layouts and loaders. |
| `layout()`     | Child layouts inside path are pre-rendered. Parent layouts are live. |
| `parallel()`   | Parallel slots inside path are pre-rendered. |
| `middleware()`  | Skipped during pre-render (no request). Runs at request time for loaders. |
| `loading()`    | Ignored without passthrough. Works for live fallback with passthrough. |
| `intercept()`  | Not pre-rendered (intercepts are navigation-triggered). |

## Dev Mode

In dev mode, `createPrerenderHandler` is a normal handler. Routes render live
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
Routes using `createPrerenderHandler` must have a `name` in path options.
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
import { createPrerenderHandler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { href } from "../router.js";

const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
};

export const GuidesDetail = createPrerenderHandler<{ slug: string }>(
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

## Trie Flags

Pre-rendered routes set flags on the route trie leaf at build time:

- `pr: true` -- route has pre-rendered B segment data
- `pt: true` -- passthrough mode (handler available for live fallback)

At runtime, the cache-lookup middleware uses these flags:
- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to live handler (handler kept in bundle)
- `pr + miss` (no pt) -- fall through (handler stubbed, no live render)
