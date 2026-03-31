# Consolidate Generated Route Type Files

## Status: Implemented

## Problem

The router currently generates three categories of `.gen.ts` files:

1. **Per-module** (`urls/blog.gen.ts`) — local route map for each `urls()` module
2. **Root urls** (`urls.gen.ts`) — aggregated routes from main urls + includes
3. **Router named-routes** (`router.named-routes.gen.ts`) — global `GeneratedRouteMap`

Categories 1 and 2 were originally needed to work around cyclic TypeScript
references. The `router.named-routes.gen.ts` file now solves that problem
globally. The per-module and root gen files add noise and complexity for
most users who don't need scoped short route names.

## Previous State

Handler files used to import their sibling `.gen.ts`:

```typescript
// urls/blog.handlers.tsx (BEFORE)
import type { routes } from "./blog.gen.js";

export const BlogIndexHandler: Handler<"index", routes> = (ctx) => {
  const href = scopedReverse<routes>(ctx.reverse);
  href("post", { postId: "1" }); // short name
  ctx.reverse("shop.cart"); // global name
};
```

The per-module gen file provided:

- Short route names (`"index"` instead of `"blog.index"`)
- Scoped `scopedReverse<routes>()` autocomplete limited to local routes

## Proposal

### Default: only `router.named-routes.gen.ts`

The Vite plugin stops generating per-module `.gen.ts` and root `urls.gen.ts`
files. Only `router.named-routes.gen.ts` is generated automatically.

Handlers use the global `GeneratedRouteMap` with full dotted names:

```typescript
// urls/blog.handlers.tsx — no gen import needed
export const BlogIndexHandler: Handler<"blog.index"> = (ctx) => {
  ctx.reverse("blog.post", { postId: "1" }); // full dotted name
  ctx.reverse("shop.cart"); // same as before
};
```

### Opt-in: `npx rango generate <file>` for per-module isolation

Users who want scoped short names for a specific module run:

```
npx rango generate urls/blog.tsx
```

This creates `urls/blog.gen.ts` with the local route map. The existing
`Handler<"index", routes>` + `scopedReverse<routes>()` pattern then works
for that module.

Per-module gen files are **not** kept in sync by the file watcher. Users
re-run the CLI command when they change routes in that module.

## Changes Made

### Vite Plugin (`src/vite/index.ts`)

1. **Removed** `writePerModuleRouteTypes()` call from dev startup
2. **Removed** `writePerModuleRouteTypesForFile()` call from file watcher
3. **Removed** unused imports of both functions

Everything related to `router.named-routes.gen.ts` remains unchanged:

- `writeRouteTypesFiles()` — runtime discovery writes named-routes (kept as-is)
- Static parser pre-generation on startup for IDE support (kept as-is, always enabled)

### CLI (`npx rango generate`)

New CLI command that reuses `writePerModuleRouteTypesForFile()`:

```
npx rango generate <file>     # generate per-module .gen.ts for one file
```

Reads the source file, extracts routes via static parser, writes sibling
`.gen.ts`. Same logic as the current `writePerModuleRouteTypesForFile()`,
just invoked manually.

### Handler Migration

Existing handlers using `Handler<"index", routes>` continue to work if
their `.gen.ts` file exists. For the default (no per-module gen file):

| Before                                        | After                                  |
| --------------------------------------------- | -------------------------------------- |
| `Handler<"index", routes>`                    | `Handler<"blog.index">`                |
| `scopedReverse<routes>(ctx.reverse)`          | `ctx.reverse` directly                 |
| `href("post", { postId })`                    | `ctx.reverse("blog.post", { postId })` |
| `import type { routes } from "./blog.gen.js"` | (removed)                              |

### Files Removed from Auto-Generation

| File pattern                     | Action                                |
| -------------------------------- | ------------------------------------- |
| `urls/*.gen.ts` (per-module)     | No longer auto-generated              |
| `urls.gen.ts` (root aggregation) | No longer auto-generated              |
| `router.named-routes.gen.ts`     | **Kept** — the single source of truth |

### Build Pipeline

The static parser (`extractRoutesFromSource`, `buildCombinedRouteMap`) stays
in the codebase — used by the CLI command. Only the automatic invocation
from the Vite plugin is removed.

## Benefits

- Fewer generated files cluttering the project (1 vs N+2)
- Simpler mental model: one global route map, full dotted names
- No implicit file generation that surprises users
- Per-module isolation is explicit and intentional
- Less Vite plugin work on startup and file changes

## Tradeoffs

- Handlers use longer dotted names (`"blog.post"` vs `"post"`)
- `scopedReverse` becomes a power-user feature
- Per-module gen files go stale if user forgets to re-run CLI
