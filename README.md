# RSC Router

A code-first, type-safe React Server Components router for serverless deployments.

## Features

- **Code-first routing** - No file-based conventions
- **Type-safe params** - Automatic inference from route patterns
- **Partial rendering** - Optimal performance with RSC
- **Parallel routes** - First-class support for complex layouts
- **Intercepting routes** - Modal patterns with soft navigation
- **Server Actions** - Mutations with automatic revalidation
- **Middleware** - Auth, logging, rate limiting
- **Error/NotFound boundaries** - Graceful error handling

## Structure

```
.
├── packages/
│   ├── rsc-router/       # Main RSC router package
│   └── host-router/      # Host router utilities
├── examples/
│   └── vite-rsc-demo/    # Demo app with shop example
└── docs/                 # API documentation
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
import { route, map, createRSCRouter } from "rsc-router/server";

// Define routes
export const shopRoutes = route({
  index: "/",
  products: { detail: "/product/:slug" },
});

// Create router
const router = createRSCRouter();
router.route("/shop", shopRoutes).map(() => import("./handlers/shop"));

// Define handlers
export default map<typeof shopRoutes>(({ route, layout }) => [
  layout(<ShopLayout />),
  route("index", () => <ProductList />),
  route("products.detail", (ctx) => <ProductPage slug={ctx.params.slug} />),
]);
```

## Documentation

See [docs/README.md](./docs/README.md) for API reference and [NEXT.md](./NEXT.md) for roadmap.

## Scripts

- `pnpm dev` - Start development mode
- `pnpm build` - Build all packages
- `pnpm preview` - Preview production builds
- `pnpm type-check` - Run TypeScript type checking

## Built With

- [React 19](https://react.dev/) - React Server Components
- [Vite](https://vitejs.dev/) + [@vitejs/plugin-rsc](https://github.com/nickreese/vite-plugin-rsc)
- [TypeScript](https://www.typescriptlang.org/)
- [Turbo](https://turbo.build/) - Monorepo orchestration

## License

MIT
