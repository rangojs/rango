# RSC Router

A code-first, type-safe React Server Components router for serverless deployments.

## Features

- **Code-first routing** - No file-based conventions
- **Type-safe params** - Automatic inference from route patterns
- **Django-style URL patterns** - `urls()` and `include()` for composition
- **Partial rendering** - Optimal performance with RSC
- **Parallel routes** - First-class support for complex layouts
- **Intercepting routes** - Modal patterns with soft navigation
- **Server Actions** - Mutations with automatic revalidation
- **Middleware** - Auth, logging, rate limiting
- **Error/NotFound boundaries** - Graceful error handling
- **Pre-rendering** - Build-time caching for static content

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

- Node.js 18+
- pnpm 8+

### Installation

```bash
pnpm install
pnpm build
pnpm dev
```

## Quick Example

```typescript
import { createRouter, urls, include } from "@rangojs/router";

// Define URL patterns (Django-style)
const shopPatterns = urls(({ path }) => [
  path("", () => <ShopIndex />),
  path("cart", () => <CartPage />),
  path("product/:slug", async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    return <ProductDetail product={product} />;
  }),
]);

// Create router and register patterns
const router = createRouter();
router.routes(
  urls(({ path }) => [
    path("", () => <Home />),
    path("shop/*", include(shopPatterns)),
  ])
);
```

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
- [Vite](https://vitejs.dev/) + [@anthropic-ai/vite-plugin-rsc](https://github.com/anthropics/vite-plugin-rsc)
- [TypeScript](https://www.typescriptlang.org/)

## License

MIT
