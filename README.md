# Vite RSC Monorepo

A Turbo-powered monorepo for React Server Components with Vite and a custom RSC router.

## Structure

```
.
├── apps/
│   └── web/              # Main web application
├── packages/
│   └── rsc-router/       # RSC Router package
└── package.json          # Root workspace configuration
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

## Workspaces

### Apps

- **`apps/web`**: Main web application using Vite + RSC + rsc-router
  - React Server Components with [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)
  - Custom RSC router with partial rendering support
  - Serverless-optimized architecture

### Packages

- **`packages/rsc-router`**: React Server Components router
  - Partial rendering support for optimal performance
  - Lazy loading optimized for serverless environments
  - Type-safe routing with TypeScript
  - Parallel routes and nested layouts

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

The `rsc-router` package is developed in `packages/rsc-router`. Changes will be automatically reflected in the web app during development thanks to Turbo's watch mode.

See [Router API Ideas](./src/Router%20API%20Ideas.md) for detailed documentation on the router architecture and API design.

### API Usage

The example app demonstrates RSC patterns:

- [`apps/web/vite.config.ts`](./apps/web/vite.config.ts) - Vite RSC plugin configuration
- [`apps/web/src/framework/entry.rsc.tsx`](./apps/web/src/framework/entry.rsc.tsx) - RSC entry point
- [`apps/web/src/framework/entry.ssr.tsx`](./apps/web/src/framework/entry.ssr.tsx) - SSR entry point
- [`apps/web/src/framework/entry.browser.tsx`](./apps/web/src/framework/entry.browser.tsx) - Client entry point
- [`apps/web/src/routes.tsx`](./apps/web/src/routes.tsx) - Route definitions

### Adding a New Package

1. Create a new directory under `packages/` or `apps/`
2. Add a `package.json` with appropriate scripts
3. Update dependencies as needed
4. Run `pnpm install` from the root

## Original Example

This monorepo is based on the Vite + RSC example. See the original documentation:
- [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) for plugin documentation
- [vite-plugin-rsc-deploy-example](https://github.com/hi-ogawa/vite-plugin-rsc-deploy-example) for deployment examples

## License

MIT