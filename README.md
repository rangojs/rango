# RSC Router

A code-first, type-safe React Server Components router for serverless deployments.

## Features

- **Code-first routing** - No file-based conventions
- **Named routes** - Type-safe `reverse()` references that survive path refactors
- **Type-safe params** - Automatic inference from route patterns
- **Django-style URL patterns** - `urls()` and `include()` for composition
- **Partial rendering** - Optimal performance with RSC
- **Parallel routes** - First-class support for complex layouts
- **Intercepting routes** - Modal patterns with soft navigation
- **Server Actions** - Mutations with automatic revalidation
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
├── examples/
│   └── vite-rsc-demo/     # Demo app
└── docs/                  # Design documents
```

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 10+

### Installation

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
- `pnpm type-check` - Run TypeScript type checking

## Built With

- [React 19](https://react.dev/) - React Server Components
- [Vite](https://vitejs.dev/) + [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-rsc)
- [TypeScript](https://www.typescriptlang.org/)

## License

MIT
