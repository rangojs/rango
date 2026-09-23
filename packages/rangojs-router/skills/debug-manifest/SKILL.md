---
name: debug-manifest
description: Inspect the router's route manifest (route/layout tree, shortCodes, parent links, loader/middleware flags) and diff it between versions. Use when routes aren't matching as expected, you need to see the generated route tree, or a path resolves to the wrong handler.
argument-hint:
---

# Debug Manifest

Dump the route manifest the router builds from your `urls()` tree to verify
parent relationships, shortCodes, and which segments carry loaders, middleware,
error boundaries, parallel slots, or intercepts. This is a development aid; the
diff helpers below are internal and may change between releases.

## Programmatic access

The router returned by `createRouter()` has an async `debugManifest()` method:

```typescript
import { router } from "./router.js";

// Development only
if (process.env.NODE_ENV !== "production") {
  const manifest = await router.debugManifest();
  console.log(JSON.stringify(manifest, null, 2));
}
```

Run it on the server side (for example from a dev-only route handler), since
it evaluates your `urls()` tree. The result type is `SerializedManifest`
(`import type { SerializedManifest } from "@rangojs/router"`).

### `include()` groups are not expanded

`include()` groups are lazy: the router evaluates one on the first request that
matches its prefix. `debugManifest()` does not evaluate them. It lists the
routes and layouts declared directly in each `.routes()` / `urls` mount, so the
routes inside an included group are missing from `routes` and `totalRoutes`.
For their names and patterns, read the generated `*.named-routes.gen.ts` file,
which lists every route including those in `include()` groups.

## Manifest structure

`debugManifest()` returns `{ routes, layouts, totalRoutes, totalLayouts }`.
Every entry has the same fields; `pattern` is present on routes only. Cache
boundaries are listed under `layouts` with `type: "cache"`. Shape (values are
illustrative):

```json
{
  "routes": {
    "home.index": {
      "id": "debug.M0.$root.$route.0.home.index",
      "shortCode": "M0L0R0",
      "type": "route",
      "parentShortCode": "M0L0",
      "pattern": "/",
      "hasLoader": false,
      "hasMiddleware": false,
      "hasErrorBoundary": false,
      "parallelCount": 0,
      "interceptCount": 0
    }
  },
  "layouts": {
    "debug.M0.$root": {
      "id": "debug.M0.$root",
      "shortCode": "M0L0",
      "type": "layout",
      "parentShortCode": null,
      "hasLoader": false,
      "hasMiddleware": false,
      "hasErrorBoundary": false,
      "parallelCount": 0,
      "interceptCount": 0
    }
  },
  "totalRoutes": 45,
  "totalLayouts": 18
}
```

## ShortCode format

A shortCode is the parent's shortCode plus one segment per level:

| Prefix | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| **M**  | Mount index (`.routes()` / `urls` registrations and `include()` mounts) |
| **L**  | Layout (the router adds a root layout, `M<n>L0`)                        |
| **C**  | Cache boundary                                                          |
| **R**  | Route                                                                   |
| **P**  | Parallel slot                                                           |
| **I**  | `include()` scope token, so included routes never collide with siblings |

Example: `M0L0L1C0R0` = Mount 0 → Root Layout → Nested Layout → Cache → Route.
At runtime, a route from an `include()` placed under the root layout gets a
shortCode such as `M0L0I0R0`.

## Debugging checklist

1. **Correct hierarchy**: the shortCode reflects nesting (`M0L0L1R0` for a
   route in a nested layout, not `M0L0R0`).
2. **Parents**: only a mount's root layout (`M<n>L0`) has
   `parentShortCode: null`.
3. **Loaders attached**: `hasLoader: true` on routes/layouts that declare
   `loader()`.
4. **Intercepts registered**: `interceptCount > 0` where you declared
   `intercept()` for modal/overlay patterns.
5. **Slots**: `parallelCount` matches the number of `parallel()` slots.

## Comparing manifests

```typescript
import {
  compareManifests,
  formatManifestDiff,
} from "@rangojs/router/__internal";

const oldManifest = await router.debugManifest();
// ... make changes ...
const newManifest = await router.debugManifest();

const diff = compareManifests(oldManifest, newManifest);
console.log(formatManifestDiff(diff));
```

`compareManifests` reports added, removed, and changed routes and layouts
(field-level: `old` / `new` per changed field).

## Common issues

### A route sits under the wrong layout

Check that the `layout()` call wraps the route in its `use` callback
(`layout(<Shell />, () => [path(...)])`). A `path()` listed next to a
`layout()` is a sibling, not a child.

### Unexpected mount index

Each `.routes()` call (and the `urls` option) registers a separate mount (M0,
M1, ...), and each `include()` also takes a mount index. Routes registered by
separate `.routes()` calls do not share layouts or middleware; compose modules
with `include()` inside one `urls()` tree when they should (`/composability`).

### Missing flags

`hasMiddleware` / `hasLoader` / `hasErrorBoundary` are per entry. Middleware or
a loader declared on a parent layout shows on that layout, not on each child
route.
