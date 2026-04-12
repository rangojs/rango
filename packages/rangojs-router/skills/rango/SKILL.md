---
name: rango
description: Overview of @rangojs/router and available skills
argument-hint:
---

# @rangojs/router

Django-inspired RSC router with composable URL patterns, type-safe href, and server components.

## Skills

| Skill                   | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `/router-setup`         | Create and configure the RSC router                                        |
| `/route`                | Define routes with `urls()` and `path()`                                   |
| `/layout`               | Layouts that wrap child routes                                             |
| `/loader`               | Data loaders with `createLoader()`                                         |
| `/middleware`           | Request processing and authentication                                      |
| `/intercept`            | Modal/slide-over patterns for soft navigation                              |
| `/parallel`             | Multi-column layouts and sidebars                                          |
| `/caching`              | Segment caching with memory or KV stores                                   |
| `/use-cache`            | Function-level caching with `"use cache"` directive                        |
| `/cache-guide`          | When to use `cache()` vs `"use cache"` — differences and decision guide    |
| `/document-cache`       | Edge caching with Cache-Control headers                                    |
| `/theme`                | Light/dark mode with FOUC prevention                                       |
| `/links`                | URL generation: ctx.reverse, href, useHref, useMount, scopedReverse        |
| `/hooks`                | Client-side React hooks                                                    |
| `/typesafety`           | Type-safe routes, params, href, and environment                            |
| `/host-router`          | Multi-app host routing with domain/subdomain patterns                      |
| `/tailwind`             | Set up Tailwind CSS v4 with `?url` imports                                 |
| `/response-routes`      | JSON/text/HTML/XML/stream endpoints with `path.json()`, `path.text()`      |
| `/mime-routes`          | Content negotiation — same URL, different response types via Accept header |
| `/fonts`                | Load web fonts with preload hints                                          |
| `/migrate-nextjs`       | Migrate a Next.js App Router project to Rango                              |
| `/migrate-react-router` | Migrate a React Router / Remix project to Rango                            |

## Quick Start

```typescript
// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
]);

// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

export default createRouter({ document: Document }).routes(urlpatterns);
```

Use `/typesafety` for type-safe href and environment setup.

## CLI: `npx rango generate`

Single command to generate `.gen.ts` route type files. Auto-detects file type and
generates the appropriate output.

```bash
# Single file
npx rango generate src/urls.tsx

# Multiple files
npx rango generate src/router.tsx src/urls.tsx

# Directory (recursive scan)
npx rango generate src/

# Mix of files and directories
npx rango generate src/urls.tsx src/api/
```

### Auto-detection

Each file is classified by its contents:

| Contains       | Generated output                                                 |
| -------------- | ---------------------------------------------------------------- |
| `urls(`        | Per-module `*.gen.ts` with route names, patterns, params, search |
| `createRouter` | Per-router `*.named-routes.gen.ts` with global route map         |
| Both           | Both files                                                       |

Directories are scanned recursively for `.ts`/`.tsx` files, skipping `node_modules`,
dotfiles, and existing `.gen.` files.

### Recursive includes

The generator follows `include()` calls across files, resolving imports to build
the full route tree. Circular includes are detected and warned about.

### First-wins deduplication

When a route name appears more than once, the first definition wins and duplicates
are dropped with a warning. This applies only to the generated `.gen.ts` type files.
Define the primary route before any fallback variant that reuses the same name.

Content negotiation (see `/mime-routes`) is unaffected — negotiated routes use
distinct names (e.g. `"product"` and `"productJson"`) and the Accept header
dispatching happens at runtime in the trie, not in the type generator.

### Limitations

The CLI uses static source analysis (AST walking), not runtime execution. It cannot
extract routes defined dynamically:

- `Array.from()` or `.map()` generating path() calls
- Conditional routes behind `import.meta.env` or feature flags
- Routes computed from external data (databases, config files)
- Template literal patterns with interpolated variables

These routes are only discovered by the Vite plugin's runtime discovery during
`pnpm dev` or `pnpm build`. The CLI-generated `.gen.ts` may have fewer routes
than the runtime-generated version. During dev, the `preserveIfLarger` guard
prevents the static parser from overwriting a larger runtime-discovered file.
