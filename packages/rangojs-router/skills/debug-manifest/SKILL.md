---
name: debug-manifest
description: Debug and inspect route manifest structure. Use when routes aren't matching as expected, you need to see the generated route tree, or a path resolves to the wrong handler.
argument-hint:
---

# Debug Manifest

Inspect the route manifest to verify parent relationships, shortCodes, and route structure.

## Quick Access

In development, visit:

```
http://localhost:PORT/?__debug_manifest
```

Returns formatted JSON. The HTTP endpoint shape is `{ routerId, routeManifest, routeAncestry, routeTrie, precomputedEntries }` (see below for the programmatic API shape).

## Programmatic Access

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
