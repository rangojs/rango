# @rangojs/router

Django-inspired RSC router with type-safe partial rendering for Vite.

> **Experimental:** This package is under active development. APIs may change between releases. Install with `@experimental` tag.

## Features

- **Composable URL patterns** — Django-style `urls()` DSL with `path`, `layout`, `include`
- **Named routes** — `reverse("blogPost", { slug })` for type-safe URL generation (Django-style)
- **Data loaders** — `createLoader()` with automatic streaming and Suspense integration
- **Layouts & nesting** — Nested layouts with `<Outlet />` and parallel routes
- **Segment-level caching** — `cache()` DSL with TTL/SWR and pluggable cache stores
- **Middleware** — Route-level middleware with cookie and header access
- **Pre-rendering** — `Prerender()` and `Static()` handlers for build-time rendering
- **Theme support** — Light/dark mode with FOUC prevention and system detection
- **Host routing** — Multi-app routing by domain/subdomain via `@rangojs/router/host`
- **Response routes** — `path.json()`, `path.text()`, `path.xml()` for API endpoints
- **CLI codegen** — `rango generate` for route type generation

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

```tsx
// src/router.tsx
import { createRouter, urls } from "@rangojs/router";
import { Document } from "./document";

const urlpatterns = urls(({ path, layout }) => [
  layout(<MainLayout />, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
    path("/blog/:slug", BlogPostPage, { name: "blogPost" }),
  ]),
]);

export const router = createRouter({ document: Document }).routes(urlpatterns);

// Export typed reverse function for URL generation by route name
export const reverse = router.reverse;
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

### Path Patterns

```tsx
import { urls } from "@rangojs/router";

const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/product/:slug", ProductPage, { name: "product" }),
  path("/search/:query?", SearchPage, { name: "search" }),
  path("/files/*", FilesPage, { name: "files" }),
]);
```

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
  const { posts } = useLoader(BlogSidebarLoader);
  return (
    <ul>
      {posts.map((p) => (
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

## Navigation & Links

### Named Routes with `reverse()` (Server Components)

In server components, use `reverse()` to generate URLs by route name:

```tsx
import { Link } from "@rangojs/router/client";
import { reverse } from "./router";

function BlogIndex() {
  return (
    <nav>
      <Link to={reverse("home")}>Home</Link>
      <Link to={reverse("blogPost", { slug: "my-post" })}>My Post</Link>
      <Link to={reverse("about")}>About</Link>
    </nav>
  );
}
```

`reverse()` is type-safe — route names and required params are checked at compile time. Included routes use dotted names: `reverse("api.health")`.

Handlers also have `ctx.reverse()` directly on the context:

```tsx
const BlogPostPage: Handler<"blogPost"> = (ctx) => {
  const backUrl = ctx.reverse("blog");
  return <Link to={backUrl}>Back to blog</Link>;
};
```

### `href()` for Path Validation (Client Components)

In client components, use `href()` for compile-time path validation:

```tsx
"use client";
import { Link, href } from "@rangojs/router/client";

function Nav() {
  return (
    <nav>
      <Link to={href("/")}>Home</Link>
      <Link to={href("/blog")} prefetch="intent">
        Blog
      </Link>
      <Link to={href("/about")}>About</Link>
    </nav>
  );
}
```

`href()` validates that the path matches a registered route pattern at compile time (e.g. `/blog/my-post` matches `/blog/:slug`).

### Navigation Hook

```tsx
"use client";
import { useNavigation } from "@rangojs/router/client";

function SearchForm() {
  const { navigate, isPending } = useNavigation();

  function handleSubmit(query: string) {
    navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  return <form onSubmit={...}>{isPending && <Spinner />}</form>;
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

```tsx
import { Prerender } from "@rangojs/router";

export const ProductPage = Prerender(
  async () => {
    const featured = await db.getFeaturedProducts();
    return featured.map((p) => ({ id: p.id }));
  },
  async (ctx) => {
    const product = await db.getProduct(ctx.params.id);
    return <Product data={product} />;
  },
  { passthrough: true },
);
```

With `passthrough: true`, known params are served from the build-time cache and unknown params fall through to live rendering.

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

hostRouter.host(["*.localhost"]).map(() => import("./apps/admin/handler.js"));
hostRouter.host(["localhost"]).map(() => import("./apps/site/handler.js"));
hostRouter.fallback().map(() => import("./apps/site/handler.js"));

export default {
  async fetch(request, env, ctx) {
    return hostRouter.match(request, { env, ctx });
  },
};
```

Each sub-app has its own `createRouter()` and `urls()`. The host router lazily imports the matched app's handler. Patterns are matched in registration order — register more specific patterns (subdomains) before catch-alls.

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

The Vite plugin automatically generates a `router.named-routes.gen.ts` file that globally registers all route names, patterns, and search schemas. Type-safe `reverse()`, `Handler<"name">`, `href()`, and `RouteParams<"name">` work out of the box — no manual type registration needed. The gen file is updated on dev server startup, HMR, and production builds.

## Subpath Exports

| Export                   | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `@rangojs/router`        | Core: `createRouter`, `urls`, `createLoader`, `Handler`, `Prerender`, `Meta`      |
| `@rangojs/router/client` | Client: `Link`, `Outlet`, `href`, `useNavigation`, `useLoader`, `MetaTags`        |
| `@rangojs/router/cache`  | Cache: `CFCacheStore`, `MemorySegmentCacheStore`, `createDocumentCacheMiddleware` |
| `@rangojs/router/theme`  | Theme: `useTheme`, `ThemeProvider`, `ThemeScript`                                 |
| `@rangojs/router/host`   | Host routing: `createHostRouter`, `defineHosts`                                   |
| `@rangojs/router/vite`   | Vite plugin: `rango()`                                                            |
| `@rangojs/router/server` | Server utilities                                                                  |
| `@rangojs/router/build`  | Build utilities                                                                   |

## Examples

See the `examples/` directory for full working applications:

- [`cloudflare-basic`](../../examples/cloudflare-basic) — Cloudflare Workers with caching, loaders, theme, and pre-rendering
- [`cloudflare-multi-router`](../../examples/cloudflare-multi-router) — Multi-app host routing

## License

MIT
