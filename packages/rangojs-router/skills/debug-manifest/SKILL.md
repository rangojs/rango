---
name: debug-manifest
description: Debug and inspect route manifest structure. Use when routes aren't matching as expected, you need to see the generated route tree, or a path resolves to the wrong handler.
argument-hint:
---

# Debug Manifest

Inspect the route manifest to verify parent relationships, shortCodes, and route structure.

## Inspect a running app first

With the Vite dev server and `rango mcp` connected, use `get_discovery_status`
before trusting route output. `stale: true` means the previous successful route
generation is still available but does not include the latest edit; on
Cloudflare, also require `runtimeConvergence: "ready"` before treating discovery
as proof that workerd serves that generation.

Then use `get_routes` for the runtime route patterns, names, search schemas,
router source ownership, and pagination/truncation state. This is the best first
check for “did my route edit reach the running server?” It is read-only and does
not execute lazy providers, handlers, middleware, or loaders.

Use `router.debugManifest()` below when you need the in-process segment graph:
shortCodes, parent relationships, layout ownership, loader/middleware flags,
parallel counts, or intercept counts. The two views answer different questions;
MCP route discovery does not replace the detailed manifest structure.

## Programmatic Access

Call `router.debugManifest()` — an `async` method on the router instance:

```typescript
import { router } from "./router.js";

// Only in development
if (process.env.NODE_ENV !== "production") {
  const manifest = await router.debugManifest();
  console.log(JSON.stringify(manifest, null, 2));
}
```

## Manifest Structure

The programmatic `router.debugManifest()` call returns `{ routes, layouts, totalRoutes, totalLayouts }`:

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
      "parentShortCode": null
    }
  },
  "totalRoutes": 45,
  "totalLayouts": 18
}
```

## ShortCode Format

| Prefix | Meaning                                  |
| ------ | ---------------------------------------- |
| **M**  | Mount index (multiple `.routes()` calls) |
| **L**  | Layout                                   |
| **C**  | Cache boundary                           |
| **R**  | Route                                    |
| **P**  | Parallel slot                            |

Example: `M0L0L1C0R0` = Mount 0 → Root Layout → Nested Layout → Cache → Route

## Debugging Checklist

1. **Routes have parents**: `parentShortCode` should NOT be `null` (except root layout)
2. **Correct hierarchy**: ShortCode should reflect nesting (e.g., `M0L0R0` not `M0R0`)
3. **Loaders attached**: Check `hasLoader: true` for routes with data requirements
4. **Intercepts registered**: `interceptCount > 0` for modal/overlay patterns

## Comparing Manifests

```typescript
import {
  serializeManifest,
  compareManifests,
  formatManifestDiff,
} from "@rangojs/router/__internal";

const oldManifest = await router.debugManifest();
// ... make changes ...
const newManifest = await router.debugManifest();

const diff = compareManifests(oldManifest, newManifest);
console.log(formatManifestDiff(diff));
```

## Common Issues

### Routes have `parentShortCode: null`

Routes should have a layout parent. Check that `urls()` handler is being wrapped in root layout.

### Missing layouts in hierarchy

Verify `layout()` calls wrap child routes correctly.

### Wrong mount index

Multiple `.routes()` calls create separate mounts (M0, M1, etc.). Use `include()` to share context.
