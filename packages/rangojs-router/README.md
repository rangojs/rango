# @rangojs/router

Named-route RSC router with structural composability and type-safe partial rendering for Vite.

> **Experimental:** This package is under active development. APIs may change between releases. Install with `@experimental` tag.

## Features

- **Named routes** — `reverse("blogPost", { slug })` for type-safe URL generation (Django-style)
- **Structural composability** — Attach routes, loaders, middleware, handles, caching, prerendering, and static generation without hiding the route tree
- **Composable URL patterns** — Django-style `urls()` DSL with `path`, `layout`, `include`
- **Data loaders** — `createLoader()` with automatic streaming and Suspense integration
- **Server actions** — `"use server"` mutations with `useActionState`, `useOptimistic`, and per-segment + per-loader `revalidate()` rules
- **Live data layer** — Pre-render or cache the UI shell while loaders stay live by default at request time
- **Layouts & nesting** — Nested layouts with `<Outlet />` and parallel routes
- **Segment-level caching** — `cache()` DSL with TTL/SWR and pluggable cache stores
- **Middleware** — Route-level middleware with cookie and header access
- **Pre-rendering** — `Prerender()` and `Static()` handlers for build-time rendering
- **Theme support** — Light/dark mode with FOUC prevention and system detection
- **Host routing** — Multi-app routing by domain/subdomain via `@rangojs/router/host`
- **Response routes** — `path.json()`, `path.text()`, `path.xml()` for API endpoints
- **Trailing slash control** — Per-route canonical URLs with `"never"`, `"always"`, or `"ignore"`
- **CLI codegen** — `rango generate` for route type generation

## Design Docs

- [Execution model](./docs/internal/execution-model.md)
- [Semantic change checklist](./docs/internal/semantic-change-checklist.md)
- [Stability roadmap](./docs/internal/stability-roadmap.md)

## Installation

```bash
npm install @rangojs/router@experimental
```

Peer dependencies:

```bash
npm install react @vitejs/plugin-rsc
```

For Cloudflare Workers:

```bash
npm install @cloudflare/vite-plugin
```

## Import Paths

Use these import paths consistently:

- `@rangojs/router` — server/RSC router APIs, route DSL, `createRouter`, `urls`, `redirect`, `Prerender`, `Static`, shared types
- `@rangojs/router/client` — hooks and components such as `Link`, `Outlet`, `href`, `useNavigation`, `useLoader`, `useAction`, `useLocationState`
- `@rangojs/router/cache` — public cache APIs such as `CFCacheStore`, `MemorySegmentCacheStore`, `createDocumentCacheMiddleware`
- `@rangojs/router/host`, `@rangojs/router/theme`, `@rangojs/router/vite` — specialized public subpaths
- `@rangojs/router/rsc`, `@rangojs/router/ssr` — advanced server-only integration subpaths for custom request/HTML pipelines

Use only subpaths that are explicitly exported from the package. Avoid deep imports such as `@rangojs/router/cache/cf`.

`@rangojs/router` is conditionally resolved. Server-only root APIs such as
`createRouter()`, `urls()`, `redirect()`, `Prerender()`, and `cookies()` rely on
the `react-server` export condition and are meant to run in router definitions,
handlers, and other RSC/server modules. Outside that environment the root entry
falls back to stub implementations that throw guidance errors.

If you hit a root-entrypoint stub error:

- hooks and components like `Link`, `Outlet`, `useLoader`, `useNavigation`, and `MetaTags` belong in `@rangojs/router/client`
- cache APIs like `CFCacheStore` and `createDocumentCacheMiddleware` belong in `@rangojs/router/cache`
- host-router APIs belong in `@rangojs/router/host`

## Quick Start

### Vite Config

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [react(), rango({ preset: "cloudflare" })],
});
```

### Router

This file is a server/RSC module and should import router construction APIs from
`@rangojs/router`.

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";

export const router = createRouter().routes(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
]);

export const reverse = router.reverse;
// reverse("home") -> "/"
```

For larger apps, extract route modules with `urls()` and compose with `include()`:

```tsx
import { createRouter, urls } from "@rangojs/router";
import { blogPatterns } from "./urls/blog";

const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/blog", blogPatterns, { name: "blog" }),
]);

export const router = createRouter().routes(urlpatterns);
// reverse("blog.post", { slug: "hello-world" }) -> "/blog/hello-world"
```

### Document

```tsx
// src/document.tsx
"use client";

import type { ReactNode } from "react";
import { MetaTags } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## Defining Routes

Rango is a named-route router first.

Paths define where a route lives. Names define how the app refers to it.

It is also structurally composable.

As an app grows, routes can pull in external handlers, loaders, middleware, handles, cache policy, intercepts, prerendering, and static generation while keeping the route tree visible at the composition site.

### Named Routes

```tsx
import { urls } from "@rangojs/router";

const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/product/:slug", ProductPage, { name: "product" }),
  path("/search/:query?", SearchPage, { name: "search" }),
  path("/files/*", FilesPage, { name: "files" }),
]);
```

Use `ctx.reverse()` from handler context as the default way to link to routes from server code:

```tsx
const ProductPage: Handler<"product"> = (ctx) => {
  const url = ctx.reverse("product", { slug: "widget" }); // "/product/widget"
  const searchUrl = ctx.reverse("search", undefined, { q: "rsc" }); // "/search?q=rsc"
  return <Link to={url}>Widget</Link>;
};
```

`router.reverse()` (exported from the router module) is the same function without a handler context, useful in scripts or tests. In request code, prefer `ctx.reverse()` — it auto-fills mount params from the current match.

### Composable URL Modules

Local route names compose cleanly with `include(..., { name })`:

```tsx
import { urls } from "@rangojs/router";

export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndexPage, { name: "index" }),
  path("/:slug", BlogPostPage, { name: "post" }),
]);

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/blog", blogPatterns, { name: "blog" }),
]);

router.reverse("blog.index"); // "/blog"
router.reverse("blog.post", { slug: "hello-world" }); // "/blog/hello-world"
```

This is the core composition model:

- Paths stay local to the module that defines them
- Names become stable references across the app
- `include()` scales those names without forcing raw path-string coupling

### Structural Composability

Rango avoids the usual tradeoff between modularity and visibility.

You can extract route behavior into separate files or packages and still keep one readable route definition that shows the structure of the app.

```tsx
import { urls } from "@rangojs/router";
import { ProductPage } from "./routes/product";
import { ProductLoader } from "./loaders/product";
import { productMiddleware } from "./middleware/product";
import { productRevalidate } from "./revalidation/product";

const shopPatterns = urls(({ path, loader, middleware, revalidate, cache }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    middleware(productMiddleware),
    loader(ProductLoader),
    revalidate(productRevalidate),
    cache({ ttl: 300 }),
  ]),
]);
```

The route tree stays explicit even when behavior is modular.

This applies to:

- external route modules mounted with `include()`
- imported loaders, middleware, and handles attached at the route site
- prerendering and static generation attached without turning the route tree opaque

### Loaders As the Live Data Layer

Rango separates app structure from app data.

Routes, layouts, and pre-rendered segments can be static or cached, while
loaders stay live by default and re-resolve at request time.

This means you can pre-render or cache the shell of a page without freezing its
data.

- `cache()` caches route structure and rendered UI segments
- `Prerender()` skips loaders at build time
- `loader()` provides fresh request-time data
- individual loaders can opt into caching explicitly when needed

```tsx
import { urls, Prerender } from "@rangojs/router";
import { ArticleLoader } from "./loaders/article";

const docsPatterns = urls(({ path, loader }) => [
  path("/docs/:slug", Prerender(DocsArticle), { name: "docs.article" }, () => [
    loader(ArticleLoader), // fresh by default
  ]),
]);
```

Pre-render the page, keep the data live.

### Typed Handlers

Route handlers receive a typed context with params, search params, and `reverse()`:

```tsx
import type { Handler } from "@rangojs/router";

export const ProductPage: Handler<"product"> = (ctx) => {
  const { slug } = ctx.params; // typed from pattern
  const homeUrl = ctx.reverse("home"); // type-safe URL by route name
  return <h1>Product: {slug}</h1>;
};
```

### Choosing a Handler Style

All handler typing styles are supported, but they solve different problems:

- `Handler<"product">` — default for named app routes
- `Handler<".post", ScopedRouteMap<"blog">>` — best for reusable included modules
- `Handler<"/blog/:slug">` — good for unnamed or local-only extracted handlers
- `Handler<{ slug: string }>` — escape hatch for advanced or decoupled cases

Example of a scoped local name inside a mounted module:

```tsx
import type { Handler } from "@rangojs/router";
import type { ScopedRouteMap } from "@rangojs/router/__internal";

type BlogRoutes = ScopedRouteMap<"blog">;

export const BlogPostPage: Handler<".post", BlogRoutes> = (ctx) => {
  return <a href={ctx.reverse(".index")}>Back to blog</a>;
};
```

See [`../../docs/named-routes.md`](../../docs/named-routes.md) for the recommended mental model.

### Search Params

Define a search schema on the route for type-safe search parameters:

```tsx
const urlpatterns = urls(({ path }) => [
  path("/search", SearchPage, {
    name: "search",
    search: { q: "string", page: "number?", sort: "string?" },
  }),
]);

// Handler receives typed search params via ctx.search
const SearchPage: Handler<"search"> = (ctx) => {
  const { q, page, sort } = ctx.search;
  // q: string, page: number | undefined, sort: string | undefined
};
```

### Trailing Slash Handling

Trailing slash behavior is a current `path()` feature.

Set it per route with `trailingSlash`:

```tsx
const urlpatterns = urls(({ path }) => [
  path("/about", AboutPage, {
    name: "about",
    trailingSlash: "never",
  }),
  path("/docs/", DocsPage, {
    name: "docs",
    trailingSlash: "always",
  }),
  path("/webhook", WebhookHandler, {
    name: "webhook",
    trailingSlash: "ignore",
  }),
]);
```

Modes:

- `"never"` — canonical URL has no trailing slash, redirects `/about/` to `/about`
- `"always"` — canonical URL has a trailing slash, redirects `/docs` to `/docs/`
- `"ignore"` — matches both forms without redirect

Default behavior when `trailingSlash` is omitted:

- There is no separate global default mode
- If the pattern is defined without a trailing slash, the canonical URL is the no-slash form
- If the pattern is defined with a trailing slash, the canonical URL is the slash form
- The router redirects to the canonical form based on the pattern you defined

The recommended public API is the per-route `path(..., { trailingSlash })` option. Use `"ignore"` sparingly, especially on content pages, because `/x` and `/x/` are distinct URLs.

### Response Routes

Define API endpoints that bypass the RSC pipeline:

```tsx
const urlpatterns = urls(({ path }) => [
  path.json("/api/health", () => ({ status: "ok" }), { name: "health" }),
  path.text("/robots.txt", () => "User-agent: *\nAllow: /", { name: "robots" }),
  path.xml("/feed.xml", () => "<rss>...</rss>", { name: "feed" }),
]);
```

Response types available: `path.json()`, `path.text()`, `path.html()`, `path.xml()`, `path.image()`, `path.stream()`, `path.any()`.

## Layouts & Nesting

### Layouts with Outlet

```tsx
import { urls } from "@rangojs/router";

const urlpatterns = urls(({ path, layout }) => [
  layout(<MainLayout />, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
]);
```

```tsx
"use client";
import { Outlet } from "@rangojs/router/client";

function MainLayout() {
  return (
    <div>
      <nav>...</nav>
      <Outlet />
    </div>
  );
}
```

### Loading Skeletons

```tsx
const urlpatterns = urls(({ path, loading }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    loading(<ProductSkeleton />),
  ]),
]);
```

### Parallel Routes

```tsx
const urlpatterns = urls(({ path, layout, parallel, loader, loading }) => [
  layout(BlogLayout, () => [
    parallel({ "@sidebar": BlogSidebarHandler }, () => [
      loader(BlogSidebarLoader),
      loading(<SidebarSkeleton />),
    ]),
    path("/blog", BlogIndexPage, { name: "blog" }),
    path("/blog/:slug", BlogPostPage, { name: "blogPost" }),
  ]),
]);
```

## Data Loaders

### Creating a Loader

```tsx
import { createLoader } from "@rangojs/router";

export const BlogSidebarLoader = createLoader(async (ctx) => {
  const posts = await db.getRecentPosts();
  return { posts, loadedAt: new Date().toISOString() };
});
```

### Using in Server Components (Handlers)

```tsx
import type { HandlerContext } from "@rangojs/router";
import { BlogSidebarLoader } from "./loaders/blog";

async function BlogSidebarHandler(ctx: HandlerContext) {
  const { posts } = await ctx.use(BlogSidebarLoader);
  return (
    <ul>
      {posts.map((p) => (
        <li key={p.slug}>{p.title}</li>
      ))}
    </ul>
  );
}
```

### Using in Client Components

```tsx
"use client";
import { useLoader } from "@rangojs/router/client";
import { BlogSidebarLoader } from "./loaders/blog";

function BlogSidebar() {
  const { data } = useLoader(BlogSidebarLoader);
  return (
    <ul>
      {data.posts.map((p) => (
        <li key={p.slug}>{p.title}</li>
      ))}
    </ul>
  );
}
```

### Attaching Loaders to Routes

```tsx
const urlpatterns = urls(({ path, loader }) => [
  path("/blog", BlogIndexPage, { name: "blog" }, () => [
    loader(BlogSidebarLoader),
  ]),
]);
```

## Server Actions

Server actions are React's RSC mutation primitive. Define them with the
`"use server"` directive — Rango uses standard React 19 hooks
(`useActionState`, `useFormStatus`, `useOptimistic`) with no framework wrapper.

```tsx
// app/actions/cart.ts
"use server";

import { getRequestContext } from "@rangojs/router";

export async function addToCart(productId: string): Promise<void> {
  const ctx = getRequestContext();
  const userId = ctx.get("user").id;
  await db.cart.insert({ userId, productId });
}
```

```tsx
// Client form with progressive enhancement + pending state
"use client";
import { useActionState } from "react";
import { saveProfile } from "../actions/profile";

export function ProfileForm() {
  const [state, action, pending] = useActionState(saveProfile, null);
  return (
    <form action={action}>
      <input name="name" defaultValue={state?.values?.name} />
      {state?.errors?.name && <p role="alert">{state.errors.name}</p>}
      <button disabled={pending}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}
```

After an action runs, matched route segments (path/layout/parallel/intercept)
and loaders can re-render/re-resolve so the UI reflects the new state.
Attach a `revalidate(({ actionId }) => ...)` rule on any segment or loader
that owns data the action touched:

```tsx
urls(({ path, loader, revalidate }) => [
  // Segment-level: re-render the cart page handler after cart actions.
  // Nest loaders that belong to this route inside the same path() so the
  // segment owns its data dependencies.
  path("/cart", CartPage, { name: "cart" }, () => [
    revalidate(
      ({ actionId }) => actionId?.startsWith("src/actions/cart.ts#") ?? false,
    ),
    loader(CartLoader, () => [
      revalidate(
        ({ actionId }) => actionId?.startsWith("src/actions/cart.ts#") ?? false,
      ),
    ]),
  ]),
]);
```

For the full guide — validation with Zod, error handling, file uploads,
`useOptimistic`, redirects, and progressive enhancement — see the
`/server-actions` skill.

## Navigation & Links

### Named Routes with `ctx.reverse()` (Server)

In server components and handlers, use `ctx.reverse()` to generate URLs by route name. This is the default — it is typed, auto-fills mount params from the current match, and resolves both local (`.name`) and absolute (`name.sub`) names:

```tsx
import { Link } from "@rangojs/router/client";
import type { Handler } from "@rangojs/router";

const BlogPostPage: Handler<"blogPost"> = (ctx) => {
  const backUrl = ctx.reverse("blog");
  return <Link to={backUrl}>Back to blog</Link>;
};
```

`reverse()` is type-safe — route names and required params are checked at compile time. Included routes use dotted names: `ctx.reverse("api.health")`.

For scripts, tests, or other code without a handler context, import the router-level `reverse`:

```tsx
import { reverse } from "./router";
reverse("blogPost", { slug: "my-post" });
```

### Client Components

**`reverse()` is server-only.** It depends on the route manifest and handler context — neither is available in the browser bundle. Client components receive URLs as props, loader data, or server-action return values:

```tsx
// server
function BlogIndex(ctx: HandlerContext) {
  return (
    <Nav
      home={ctx.reverse("home")}
      post={ctx.reverse("blogPost", { slug: "my-post" })}
    />
  );
}
```

```tsx
"use client";
import { Link } from "@rangojs/router/client";

export function Nav({ home, post }: { home: string; post: string }) {
  return (
    <nav>
      <Link to={home}>Home</Link>
      <Link to={post}>My Post</Link>
    </nav>
  );
}
```

For client-side navigation to static paths (no named-route lookup), use `href()` — see below. For URLs tied to named routes, you have two options: import the per-module generated `routes` map and use `useReverse(routes)` for in-module names (see [`/links` skill](./skills/links/SKILL.md)), or generate the URL on the server and pass the string in for cross-module URLs.

### `href()` for Path Validation (Client Components)

In client components, use `href()` for compile-time path validation on static path strings:

```tsx
"use client";
import { Link, href } from "@rangojs/router/client";

function Nav() {
  return (
    <nav>
      <Link to={href("/")}>Home</Link>
      <Link to={href("/blog")} prefetch="adaptive">
        Blog
      </Link>
      <Link to={href("/about")}>About</Link>
    </nav>
  );
}
```

`href()` validates that the path matches a registered route pattern at compile time (e.g. `/blog/my-post` matches `/blog/:slug`).

### Navigation Hooks

```tsx
"use client";
import { useNavigation, useRouter } from "@rangojs/router/client";

function SearchForm() {
  const router = useRouter();
  const nav = useNavigation();

  function handleSubmit(query: string) {
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  return <form onSubmit={...}>{nav.state !== "idle" && <Spinner />}</form>;
}
```

### Scroll Restoration

```tsx
"use client";
import { ScrollRestoration } from "@rangojs/router/client";

function Document({ children }) {
  return (
    <html>
      <body>
        {children}
        <ScrollRestoration />
      </body>
    </html>
  );
}
```

## Includes (Composable Modules)

Split URL patterns into composable modules with `include()`:

```tsx
// src/api/urls.tsx
import { urls } from "@rangojs/router";

export const apiPatterns = urls(({ path }) => [
  path.json("/health", () => ({ status: "ok" }), { name: "health" }),
  path.json("/products", getProducts, { name: "products" }),
]);

// src/urls.tsx
import { urls } from "@rangojs/router";
import { apiPatterns } from "./api/urls";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/api", apiPatterns, { name: "api" }),
  // Mounts apiPatterns under /api: /api/health, /api/products
]);
```

Included route names are prefixed with the include name: `reverse("api.health")`, `reverse("api.products")`.

### Include name scoping

The `name` option controls how child route names appear globally:

| Form                               | Child names         | Generated types        | Reverse resolution                                                   |
| ---------------------------------- | ------------------- | ---------------------- | -------------------------------------------------------------------- |
| `include("/x", p, { name: "ns" })` | `ns.child`          | Exported as `ns.child` | `reverse("ns.child")` globally, `reverse(".child")` inside           |
| `include("/x", p, { name: "" })`   | `child` (flattened) | Exported as-is         | `reverse("child")` globally, `reverse(".child")` inside (root-scope) |
| `include("/x", p)`                 | Private scope       | Not exported           | `reverse(".child")` inside only                                      |

Without a `name`, included routes are local to the mounted module. They still match requests and render normally, but their names are hidden from the generated route map and cannot be reversed globally. Use `{ name: "" }` to merge children into the parent namespace without adding a prefix.

**`{ name: "" }` is flattening, not isolation.** Flattened routes behave as if defined inline at the include site — dot-local reverse (`.name`) can reach any sibling route at root scope, including routes from other `{ name: "" }` mounts. If you need module-level isolation, omit the `name` option or use a namespace.

## Middleware

```tsx
const urlpatterns = urls(({ path, middleware }) => [
  middleware(
    async (ctx, next) => {
      const start = Date.now();
      const response = await next();
      console.log(
        `${ctx.request.method} ${ctx.url.pathname} ${Date.now() - start}ms`,
      );
      return response;
    },
    () => [path("/dashboard", DashboardPage, { name: "dashboard" })],
  ),
]);
```

## Caching

### Route-Level Caching

```tsx
const urlpatterns = urls(({ path, cache }) => [
  cache({ ttl: 60, swr: 300 }, () => [
    path("/blog", BlogIndexPage, { name: "blog" }),
    path("/blog/:slug", BlogPostPage, { name: "blogPost" }),
  ]),
]);
```

### Cache Store Configuration

```tsx
import { createRouter } from "@rangojs/router";
import {
  CFCacheStore,
  createDocumentCacheMiddleware,
} from "@rangojs/router/cache";

export const router = createRouter({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      ctx: env.ctx,
    }),
  }),
})
  .use(createDocumentCacheMiddleware())
  .routes(urlpatterns);
```

Available cache stores:

- `CFCacheStore` — Cloudflare edge cache (production)
- `MemorySegmentCacheStore` — In-memory cache (development/testing)

## Pre-rendering

Pre-rendering generates route segments at build time. The worker handles all requests — there are no static files served from assets.

### Static Segments

Use `Static()` for segments rendered once at build time (no params). Works on `path()`, `layout()`, and `parallel()`:

```tsx
import { Static } from "@rangojs/router";

export const AboutPage = Static(async () => {
  return <article>...</article>;
});

export const DocsNav = Static(async () => {
  const items = await readDocsNavItems();
  return (
    <nav>
      {items.map((i) => (
        <a key={i.slug} href={i.slug}>
          {i.title}
        </a>
      ))}
    </nav>
  );
});
```

### Dynamic Routes with Prerender

Use `Prerender()` for route-scoped pre-rendering. With params, provide `getParams` first, handler second:

```tsx
import { Prerender } from "@rangojs/router";

export const BlogPost = Prerender(
  async () => {
    const slugs = await getAllBlogSlugs();
    return slugs.map((slug) => ({ slug }));
  },
  async (ctx) => {
    const post = await getPost(ctx.params.slug);
    return <article>{post.content}</article>;
  },
);
```

### Passthrough for Unknown Params

Wrap a `Prerender` definition with `Passthrough()` to add a live handler for unknown params at runtime. The build handler runs at build time, the live handler runs at request time for params not in the prerender cache.

```tsx
import { Prerender, Passthrough } from "@rangojs/router";

export const ProductPageDef = Prerender(
  async () => {
    const featured = await db.getFeaturedProducts();
    return featured.map((p) => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.getProduct(ctx.params.id);
    return <Product data={product} />;
  },
);

// In route definition:
path(
  "/products/:id",
  Passthrough(ProductPageDef, async (ctx) => {
    const product = await ctx.env.DB.getProduct(ctx.params.id);
    return <Product data={product} />;
  }),
);
```

Build handlers can also skip individual param sets with `ctx.passthrough()`, deferring them to the live handler:

```tsx
export const ProductPageDef = Prerender(
  async () => {
    const all = await db.getAllProducts();
    return all.map((p) => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.getProduct(ctx.params.id);
    if (!product.published) return ctx.passthrough();
    return <Product data={product} />;
  },
);
```

### Build-Time Environment Bindings

Prerender handlers can access platform bindings (KV, D1, R2) at build time when `buildEnv` is configured in the Vite plugin:

```ts
// vite.config.ts
import { rango } from "@rangojs/router/vite";

rango({ preset: "cloudflare", buildEnv: "auto" });
```

With `buildEnv: "auto"`, the plugin calls `wrangler.getPlatformProxy()` to provide local bindings. Handlers then access `ctx.env` during build:

```tsx
export const BlogPosts = Prerender<{ slug: string }>(
  async (ctx) => {
    const rows = await ctx.env.DB.prepare("SELECT slug FROM posts").all();
    return rows.map((r) => ({ slug: r.slug }));
  },
  async (ctx) => {
    const post = await ctx.env.DB.prepare("SELECT * FROM posts WHERE slug = ?")
      .bind(ctx.params.slug)
      .first();
    return <BlogPost post={post} />;
  },
);
```

`buildEnv` also accepts a factory function or plain object:

```ts
// Custom factory
rango({
  buildEnv: async (ctx) => {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy();
    return { env: proxy.env, dispose: proxy.dispose };
  },
});

// Plain object (Node.js)
rango({ buildEnv: { DATABASE_URL: process.env.DATABASE_URL } });
```

Build-time env applies to both production builds and dev on-demand prerender. Without `buildEnv`, accessing `ctx.env` in a Prerender handler throws with a clear error.

## Theme

### Router Configuration

```tsx
export const router = createRouter({
  document: Document,
  theme: {
    defaultTheme: "light",
    themes: ["light", "dark", "system"],
    attribute: "class",
    enableSystem: true,
  },
}).routes(urlpatterns);
```

### Theme Toggle

```tsx
"use client";
import { useTheme } from "@rangojs/router/theme";

function ThemeToggle() {
  const { theme, setTheme, themes } = useTheme();
  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value)}>
      {themes.map((t) => (
        <option key={t}>{t}</option>
      ))}
    </select>
  );
}
```

## Host Routing

Route requests to different apps based on domain/subdomain patterns using `@rangojs/router/host`:

```tsx
// worker.rsc.tsx
import { createHostRouter } from "@rangojs/router/host";

const hostRouter = createHostRouter();

hostRouter.host(["*.localhost"]).lazy(() => import("./apps/admin/handler.js"));
hostRouter.host(["localhost"]).lazy(() => import("./apps/site/handler.js"));
hostRouter.fallback().lazy(() => import("./apps/site/handler.js"));

export default {
  async fetch(request, env, ctx) {
    return hostRouter.match(request, { env, ctx });
  },
};
```

Use `.lazy(() => import("./sub-app"))` to mount a lazily-imported sub-app (a module whose `default` export is a handler or nested host router), and `.map((request) => Response)` for an inline request handler. Only `.lazy()` mounts are imported during build-time discovery; `.map(() => import(...))` is a type error. Each sub-app has its own `createRouter()` and `urls()`. Patterns are matched in registration order — register more specific patterns (subdomains) before catch-alls.

## Meta Tags

Accumulate meta tags across route segments using the built-in `Meta` handle:

```tsx
import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

export function BlogPostPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "My Blog Post" });
  meta({ name: "description", content: "A great blog post" });
  meta({ property: "og:title", content: "My Blog Post" });

  return <article>...</article>;
}
```

Render collected tags in the document with `<MetaTags />` from `@rangojs/router/client`.

## CLI: `rango generate`

Route types are generated automatically by the Vite plugin. The CLI is a manual fallback for generating types outside the dev server (e.g. in CI or for IDE support before first `pnpm dev`):

```bash
npx rango generate src/router.tsx
npx rango generate src/                # recursive scan
npx rango generate src/urls.tsx src/api/  # mix files and directories
```

Auto-detects file type:

- Files with `createRouter` → `*.named-routes.gen.ts` with global route map
- Files with `urls()` → `*.gen.ts` with per-module route names, params, and search types

## Type Safety

The Vite plugin automatically generates a `router.named-routes.gen.ts` file that globally registers route names, patterns, and search schemas via `Rango.GeneratedRouteMap`. This powers server-side named-route typing such as `Handler<"name">`, `ctx.reverse()`, `getRequestContext().reverse()`, and `RouteParams<"name">` without any manual route registration. The gen file is updated on dev server startup, HMR, and production builds.

Use the generated map by default. Augment `Rango.RegisteredRoutes` only when you need the richer `typeof router.routeMap` shape globally, especially for response-aware and path-based utilities.

```typescript
// router.tsx
const router = createRouter<AppBindings>({}).routes(urlpatterns);

declare global {
  namespace Rango {
    interface Env extends AppEnv {}
    interface Vars extends AppVars {}
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

Quick rule of thumb:

- `GeneratedRouteMap` (auto-generated) — use for server-side named-route typing: `Handler<"name">`, `ctx.reverse()`, `Prerender<"name">`
- `typeof router.routeMap` — use when you need route entries with response metadata
- `RegisteredRoutes` (manual augmentation) — use to expose `typeof router.routeMap` globally for `href()`, `Rango.Path`, `Rango.PathResponse`, and other path/response-aware utilities

For extracted reusable loaders or middleware, prefer global dotted names on
`ctx.reverse()` by default. If you want type-safe local names for a specific
module, use `scopedReverse<typeof localPatterns>(ctx.reverse)` or
`scopedReverse<routes>(ctx.reverse)` with a generated local route type.

## Subpath Exports

| Export                   | Description                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `@rangojs/router`        | Server/RSC core and shared types: `createRouter`, `urls`, `createLoader`, `Handler`, `Prerender`, `Meta` |
| `@rangojs/router/client` | Client: `Link`, `Outlet`, `href`, `useNavigation`, `useLoader`, `MetaTags`                               |
| `@rangojs/router/cache`  | Cache: `CFCacheStore`, `MemorySegmentCacheStore`, `createDocumentCacheMiddleware`                        |
| `@rangojs/router/theme`  | Theme: `useTheme`, `ThemeProvider`, `ThemeScript`                                                        |
| `@rangojs/router/host`   | Host routing: `createHostRouter`, `defineHosts`                                                          |
| `@rangojs/router/vite`   | Vite plugin: `rango()`                                                                                   |
| `@rangojs/router/rsc`    | Advanced server pipeline APIs: `createRSCHandler`, request-context access                                |
| `@rangojs/router/ssr`    | Advanced SSR bridge APIs: `createSSRHandler`                                                             |
| `@rangojs/router/server` | Internal build/runtime utilities for advanced integrations                                               |
| `@rangojs/router/build`  | Build utilities                                                                                          |

The root entrypoint is not a generic client/runtime barrel. If you need hooks
or components, import from `@rangojs/router/client`; if you need cache or host
APIs, use their dedicated subpaths.

## Examples

See the `examples/` directory for full working applications:

- [`cloudflare-basic`](../../examples/cloudflare-basic) — Cloudflare Workers with caching, loaders, theme, and pre-rendering
- [`cloudflare-multi-router`](../../examples/cloudflare-multi-router) — Multi-app host routing

## License

MIT
