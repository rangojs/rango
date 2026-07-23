# Rango

React RSC Route Wrangler

A code-first, type-safe React Server Components router

## Stability

> **Experimental:** This package is published as `0.0.0-experimental.*` and is under active development. APIs may change between releases. Install with the `@experimental` tag:
>
> ```bash
> npm install @rangojs/router@experimental
> ```

## Why Rango?

Rango keeps simple applications simple: define a route tree, render server
components, and navigate by type-safe route names. As requirements grow, the
same tree can express data freshness, caching, partial rendering, and complex UI
composition without moving those decisions into a separate framework model.
That makes it useful to one developer out of the box while preserving a coherent,
machine-readable architecture as the application and its AI-assisted development
workflow grow more complex.

- **Readable, code-first routing** - `urls()`, `path()`, and `include()` keep URL
  structure, module boundaries, and shared concerns visible in one declared tree
  instead of making them implicit in filesystem conventions.
- **Type-safe named routes** - Generated route names, params, search schemas, and
  `reverse()` calls stay checked when paths move or modules are composed.
- **RSC with progressive-enhancement parity** - Server Components, Server
  Actions, and forms share tested behavior across client navigation and no-JS
  requests.
- **Live data beneath cached UI** - Loaders stay fresh by default, even when the
  surrounding segment is cached or prerendered, and resolve in parallel while
  the UI streams.
- **Precise client updates** - `revalidate()` controls which segments and loaders
  re-render after an action, independently from cache invalidation.
- **Composable rendering** - Named slots, parallel routes, and intercepts model
  dashboards, sidebars, modals, and alternate soft-navigation compositions in
  the route graph.
- **Controlled navigation** - Request-aware prefetching, in-flight adoption,
  Rango State with userland invalidation, partial rendering, and integrated
  deployment-skew recovery make navigation behavior explicit and stable.
- **Request and cache safety built in** - Default origin checks protect Server
  Actions, loader fetches, and no-JS form submissions, while tainted request
  context protects cache boundaries from request-specific data and effects.
- **CSP-ready rendering** - Per-request nonce generation and propagation cover
  SSR, RSC payload scripts, typed middleware access, and document-rendered script
  handles while leaving policy decisions with the application.
- **Integrated diagnostics** - `debugPerformance` exposes a request waterfall
  and `Server-Timing` headers without additional instrumentation.

See [Rango compared to Next.js, TanStack Start, and Waku](packages/rangojs-router/docs/comparison.md)
for the detailed design and capability comparison.

## Features

- **Code-first routing** - No file-based conventions
- **Named routes** - Type-safe `reverse()` references that survive path refactors
- **Type-safe params** - Automatic inference from route patterns
- **Django-style URL patterns** - `urls()` and `include()` for composition
- **Partial rendering** - Optimal performance with RSC
- **Parallel routes** - First-class support for complex layouts
- **Intercepting routes** - Modal patterns with soft navigation
- **Server Actions** - `"use server"` mutations with `useActionState` / `useOptimistic` and per-segment + per-loader `revalidate()` rules
- **Middleware** - Auth, logging, rate limiting
- **Error/NotFound boundaries** - Graceful error handling
- **Pre-rendering** - Build-time caching for static content
- **Live data loaders** - Pre-render or cache UI structure while `loader()` stays fresh by default
- **Trailing slash control** - Per-route canonical URL handling via `path(..., { trailingSlash })`

## Structure

```
.
├── packages/
│   └── rangojs-router/    # Main RSC router package
├── tests/                 # Demo + e2e apps (vite-rsc-demo, cloudflare-basic, ...)
├── examples/              # Cloudflare example apps (cloudflare-basic-nonce, cloudflare-multi-router)
├── apps/
│   └── docs/              # Documentation site
├── tools/                 # Repo tooling and bundle scripts
└── docs/                  # Design documents
```

## Getting Started

### Create an app

Start from a complete Rango template with [`create-rango`](https://github.com/rangojs/templates):

```bash
pnpm create rango my-app
```

Choose a deployment target non-interactively:

```bash
pnpm create rango my-app --template basic       # Node
pnpm create rango my-app --template cloudflare  # Cloudflare Workers
pnpm create rango my-app --template vercel      # Vercel
pnpm create rango my-app --template basic --js  # Node, JavaScript
```

Each template is a complete streaming RSC app with routes, Server Actions, and
production build/deployment configuration already wired. Use
`npm create rango@latest my-app` if you prefer npm. The scaffolder currently
requires Node.js 24 or newer.

### Prerequisites

- Node.js `^20.19.0 || >=22.12.0` for this repository (the `@rangojs/router` `engines` floor, matching Vite 8); CI tests on Node 24 (see `.nvmrc`)
- pnpm 11+ (`packageManager` is `pnpm@11.9.0`)

### Repository development

```bash
pnpm install
pnpm build
pnpm dev
```

## Quick Example

```typescript
import { createRouter } from "@rangojs/router";

const router = createRouter().routes(({ path }) => [
  path("/", () => <Home />, { name: "home" }),
  path("/about", () => <About />, { name: "about" }),
]);

router.reverse("home"); // "/"
```

For larger apps, extract route modules with `urls()` and compose with `include()`:

```typescript
import { createRouter, urls } from "@rangojs/router";

const shopPatterns = urls(({ path }) => [
  path("/", () => <ShopIndex />, { name: "index" }),
  path("/cart", () => <CartPage />, { name: "cart" }),
  path("/product/:slug", async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    return <ProductDetail product={product} />;
  }, { name: "product" }),
]);

const router = createRouter().routes(({ path, include }) => [
  path("/", () => <Home />, { name: "home" }),
  include("/shop", shopPatterns, { name: "shop" }),
]);

router.reverse("shop.cart"); // "/shop/cart"
router.reverse("shop.product", { slug: "widget" }); // "/shop/product/widget"
```

Rango treats loaders as the live data layer: pre-rendering and route-level
cache boundaries can store the UI structure, while `loader()` re-resolves fresh
request-time data by default. That lets you pre-render the page shell without
freezing the data behind it.

Trailing slash handling is supported directly on `path()`:

```typescript
const urlpatterns = urls(({ path }) => [
  path("/about", AboutPage, { name: "about", trailingSlash: "never" }),
  path("/docs/", DocsPage, { name: "docs", trailingSlash: "always" }),
  path("/webhook", WebhookHandler, {
    name: "webhook",
    trailingSlash: "ignore",
  }),
]);
```

If `trailingSlash` is omitted, there is no separate global default mode. The router uses the pattern you define as the canonical form and redirects to it.

## Debug Logging

The router has structured debug logging that is off by default. Enable it with the `INTERNAL_RANGO_DEBUG` environment variable:

```bash
INTERNAL_RANGO_DEBUG=1 pnpm dev
```

This produces structured output for server-side and client-side router operations:

```
[Router][req:req-1][tx:document-tx-1] [matchRoute] matching started { pathname: "/shop/products" }
[Browser][req:creq-1][tx:navigate-ctx-1] navigation started { url: "/shop/products" }
```

## Scripts

- `pnpm dev` - Start development mode
- `pnpm build` - Build all packages
- `pnpm preview` - Preview production builds
- `pnpm typecheck` - Run TypeScript type checking

## Built With

- [React 19](https://react.dev/) - React Server Components
- [Vite](https://vitejs.dev/) + [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)
- [TypeScript](https://www.typescriptlang.org/)

## License

MIT
