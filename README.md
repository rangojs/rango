# RSC Router

A code-first, type-safe React Server Components router for serverless deployments.

## Structure

```
.
├── packages/
│   ├── rsc-router/       # Main RSC router package
│   └── host-router/      # Host router utilities
├── examples/
│   └── vite-rsc-demo/    # Demo app with shop example
└── NEXT.md               # Development roadmap
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+

### Installation

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start development
pnpm dev
```

## Packages

### `packages/rsc-router`
React Server Components router with:
- **Code-first routing** - No file-based conventions
- **Type-safe params** - Automatic inference from route patterns
- **Partial rendering** - Optimal performance with RSC
- **Parallel routes** - First-class support for complex layouts
- **Nested routes** - Clean API for route hierarchies
- **Serverless-optimized** - Lazy loading and efficient bundling

### `packages/host-router`
Host router utilities for multi-environment deployment

### `examples/vite-rsc-demo`
Comprehensive demo application featuring:
- Ecommerce shop with nested routes
- Dynamic segments and layout composition
- Parallel routes for sidebars and widgets
- Multi-step checkout flow

## Scripts

- `pnpm dev` - Start all apps and packages in development mode
- `pnpm build` - Build all apps and packages
- `pnpm preview` - Preview production builds
- `pnpm type-check` - Run TypeScript type checking

## Development

This monorepo uses:
- **[Turbo](https://turbo.build)** for build orchestration
- **[pnpm](https://pnpm.io)** for package management
- **[Vite](https://vitejs.dev)** for development and building
- **TypeScript** for type safety

### Working with the Router

The `rsc-router` package is in `packages/rsc-router`. Changes are automatically reflected in the demo app thanks to Turbo's watch mode.

See [RSC_ROUTER_API_DESIGN.md](./RSC_ROUTER_API_DESIGN.md) for detailed API documentation and [NEXT.md](./NEXT.md) for the development roadmap.

### Quick Example

```typescript
// Define routes
export const shopRoutes = route({
  index: '/',
  products: {
    category: '/products/:category',
    detail: '/product/:slug',
  },
});

// Mount and define handlers
router
  .route('/shop', shopRoutes)
  .map(() => import('./handlers/shop.js'));

// Handler with layouts and parallel routes
export default map<typeof shopRoutes>({
  [layout("*", "shop")]: <ShopLayout />,
  [parallel("index", "sidebar")]: {
    '@sidebar': () => <CategoryFilter />
  },
  index: () => <ProductList />,
  'products.detail': (ctx) => <ProductPage slug={ctx.params.slug} />
});
```

## Status

🚧 **Active Development** - See [NEXT.md](./NEXT.md) for the current roadmap.

**Current Focus:** Phase 1 - Foundation
- ✅ Core routing with nested routes and dynamic segments
- ✅ Layout composition and parallel routes
- ✅ Partial rendering optimization
- 🚧 Revalidation logic (in progress)
- 📋 Middleware implementation (planned)
- 📋 RSC Actions/Server Actions (planned)

## Built With

- [React 19](https://react.dev/) - React Server Components
- [Vite](https://vitejs.dev/) + [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)
- [TypeScript](https://www.typescriptlang.org/)
- [Turbo](https://turbo.build/) - Monorepo orchestration
- [pnpm](https://pnpm.io/) - Package management

## License

MIT