# Route Manifest System

The route manifest maps route names to URL patterns (e.g., `{ "blog.post": "/blog/:postId" }`).
It powers `reverse()`, `href()`, and typed `Handler<"name">` without executing handler code at runtime.

## Data Flow

```
Discovery (configureServer / buildStart)
  |
  v
generateManifest() per router
  |
  v
writeRouteTypesFiles() -- writes .named-routes.gen.ts per router
  |
  v
virtual:rsc-router/routes-manifest (load hook)
  |-- imports each .named-routes.gen.js
  |-- calls setCachedManifest(__flat(merged))
  |-- calls setRouterManifest(routerId, __flat(perRouter))
  |-- registers a lazy per-router loader (registerRouterManifestLoader)
  |     -> import("virtual:rsc-router/routes-manifest/<routerId>")
  |        lazily supplies trie + precomputed entries (NOT inlined here)
  |
  v
Runtime: getGlobalRouteMap() / getRouterManifest(id) -> reverse()
```

## Gen File

Each router gets a `<basename>.named-routes.gen.ts` next to its source file.

```typescript
// Auto-generated -- do not edit
export const NamedRoutes = {
  "blog.index": "/blog",
  "blog.post": "/blog/:postId",
  // Routes with search schemas use object format:
  "href.filtered": {
    path: "/href/:filterId",
    search: { tag: "string", draft: "boolean?" },
  },
} as const;

// Aliased so the augmentation below does not pay a homomorphic mapped-type
// instantiation per route; `as const` already makes the members readonly.
type NamedRoutesShape = typeof NamedRoutes;

// Module augmentation for typed Handler<"blog.post"> and ctx.reverse("blog.post")
declare global {
  namespace Rango {
    interface GeneratedRouteMap extends NamedRoutesShape {}
  }
}
```

The augmentation targets the global `Rango` namespace (not
`declare module "@rangojs/router"`) and extends `NamedRoutesShape` (an alias of
`typeof NamedRoutes`), so the generated `const` is the single source of truth
for both runtime and types. The alias avoids the homomorphic mapped-type cost
that `Readonly<typeof NamedRoutes>` would incur at the `extends` site.

**Dual purpose:**

- **Runtime data** -- the virtual module imports `NamedRoutes` and calls `setCachedManifest()`; route matching/reverse flattens each entry to its string path.
- **Static types** -- TypeScript uses the `GeneratedRouteMap` augmentation for IDE autocomplete, keeping the per-route search schemas.

`NamedRoutes` stores **path + search** metadata only. Response payload metadata
lives in the router builder type (`typeof router.routeMap`, exposed via
`RegisteredRoutes`) and is **not** emitted into `router.named-routes.gen.ts`.

**Two creation paths:**

- `writeCombinedRouteTypes()` -- static parser, runs in `configResolved` (before server starts)
- `writeRouteTypesFiles()` -- runtime discovery output, runs after `discoverRouters()` completes

## Virtual Module

`virtual:rsc-router/routes-manifest` is the bridge between gen files and the runtime.

Generated code (simplified):

```javascript
import { NamedRoutes as _r0 } from "/abs/path/to/router.named-routes.gen.js";
import { setCachedManifest, setRouterManifest, ... } from "@rangojs/router/server";

// Flatten search schema objects to plain string paths
function __flat(r) {
  const o = {};
  for (const [k, v] of Object.entries(r))
    o[k] = typeof v === "string" ? v : v.path;
  return o;
}

clearAllRouterData();
setCachedManifest(__flat(_r0));
setRouterManifest("router_abc123", __flat(_r0));
// Trie + precomputed entries are NOT inlined in this eager module
// (Bundle Hygiene rule #1). A lazy per-router chunk supplies them on demand:
registerRouterManifestLoader("router_abc123", () =>
  import("virtual:rsc-router/routes-manifest/router_abc123"));
```

The eager module carries only the flat route maps (for `reverse()`); the trie and
precomputed match entries live in the lazy `virtual:rsc-router/routes-manifest/<routerId>`
chunk, populated via `await ensureRouterManifest(routerId)` before any matching.
Keeping that data in exactly one (lazy) chunk is a hard constraint — see CLAUDE.md
"Bundle Hygiene" rule #1; do not add `setRouteTrie`/`setPrecomputedEntries` here.

The `import` of the gen file creates a dependency in Vite's module graph.
When the gen file changes, Vite invalidates the virtual module automatically.

## HMR Flow (Dev Only)

```
Source file change (.ts/.tsx with urls() or createRouter())
  |
  v
Watcher "change" event
  |-- filters: skip .gen.ts, skip "use client", skip non-route files
  |
  v
writeCombinedRouteTypes() -- re-parses static routes from source
  |
  v
supplementGenFilesWithRuntimeRoutes() -- merges factory-only routes
  |-- uses parse cache (avoids redundant I/O per router)
  |-- merges factory route search schemas
  |
  v
Gen file written (only if content changed)
  |
  v
Vite detects file change
  |-- invalidates gen file module in module graph
  |-- invalidates virtual module (imports gen file)
  |
  v
Next request re-evaluates virtual module
  |-- setCachedManifest() called with fresh data
  |-- setRouterManifest() called per router
  |
  v
reverse() returns updated URLs
```

### Gen File Deletion Recovery

The watcher listens for `unlink` events on `.gen.ts` files:

- If runtime discovery data is available (`perRouterManifests`), calls `writeRouteTypesFiles()`
- Otherwise falls back to `writeCombinedRouteTypes()` (static parser)
- The file is recreated synchronously before the next request

### Factory-Only Routes

Routes from factory functions (e.g., `createDocsPatterns()`) are invisible to the static parser.
`supplementGenFilesWithRuntimeRoutes()` handles this:

1. During discovery, `factoryOnlyPrefixes` is computed -- route name prefixes (e.g., `"docs."`)
   that exist in the runtime manifest but not in the static parser output
2. After `writeCombinedRouteTypes()` writes the static-only gen file, `supplementGenFilesWithRuntimeRoutes()`
   overwrites it with a merged version: static routes + factory-only groups from the runtime manifest
3. Static routes are authoritative (reflecting renames/additions/removals in source);
   factory routes fill the gaps for groups the parser can't resolve

## Multi-Router

Each `createRouter()` gets isolated data:

- `setRouterManifest(routerId, manifest)` -- per-router route map
- `setRouterTrie(routerId, trie)` -- per-router matching trie
- `setRouterPrecomputedEntries(routerId, entries)` -- per-router precomputed leaf entries

`ctx.reverse()` resolves via `getRouterManifest(routerId) ?? getGlobalRouteMap()`.

Per-router virtual modules (`virtual:rsc-router/routes-manifest/<routerId>`) are loaded lazily
via `registerRouterManifestLoader()` / `ensureRouterManifest()` on first request.

Router roots must be sibling app roots. Nested router roots are not supported:
if a router source file lives under another router's directory, Vite runtime
discovery and `rango generate` fail with an explicit error. This keeps static
route-type generation scoped to the nearest router root and avoids deep
redundant filesystem scans in large projects.

## Static vs Runtime Generation Boundary

The CLI (`rango generate`) has two modes for producing `.named-routes.gen.ts`:

| Mode             | Flag        | Discovery                                                        | Coverage                                  |
| ---------------- | ----------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Static (default) | (none)      | AST-only, no Vite server                                         | Named routes visible to the static parser |
| Runtime          | `--runtime` | Spins up a temp Vite server, imports entry via RSC module runner | 100% of registered routes                 |

**Design rule:** when the static parser encounters route tree structures it
cannot reconstruct (factory function calls, dynamic expressions, conditional
registrations), it must **fail fast with a clear diagnostic** pointing the
user to `--runtime`. It must never silently emit incomplete or wrong output
in default mode.

Concretely:

- `detectUnresolvableIncludes()` scans router files for `include()` calls
  whose second argument is a function call or expression the parser cannot
  resolve. These are classified as `"factory-call"` or `"unresolvable"`.
- In default mode, any unresolvable include causes a hard error with the
  list of unresolvable prefixes and the suggestion to use `--runtime`.
- In `--static` mode, partial output is accepted with a warning.
- In `--runtime` mode, the Vite server evaluates the actual module graph,
  so factory functions execute and all routes are discovered.

This is intentional: "hard runtime augmentation parity" is not a goal of
the static parser. The static parser is a fast, dependency-free path for
the common case. When the route tree is too dynamic for static analysis,
the correct answer is `--runtime`, not a best-effort guess.

## Configuration

```typescript
rango({
  preset: "cloudflare",
});
```

## Build vs Dev

| Aspect             | Dev                                     | Build                                          |
| ------------------ | --------------------------------------- | ---------------------------------------------- |
| Discovery          | `configureServer` hook, live RSC runner | `buildStart` hook, temp Vite server            |
| Gen file updates   | File watcher + supplement               | Single write after discovery                   |
| Virtual module     | Re-evaluated on each request after HMR  | Bundled by Rollup (gen file inlined)           |
| Manifest readiness | `manifestReadyPromise` gate             | Synchronous (discovery completes before build) |

Both modes produce the same virtual module output. The `import` from gen file works in both:
Vite resolves it in dev, Rollup bundles it in build.

## Runtime Storage

Three tiers in `route-map-builder.ts`:

| Storage                | API                                           | Purpose                                                             |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `cachedManifest`       | `setCachedManifest()` / `getGlobalRouteMap()` | Global merged manifest from all routers                             |
| `perRouterManifestMap` | `setRouterManifest()` / `getRouterManifest()` | Per-router isolated manifests                                       |
| `globalRouteMap`       | `registerRouteMap()`                          | Runtime-accumulated fallback (used before virtual module evaluates) |

`getGlobalRouteMap()` returns `cachedManifest` if available, otherwise `globalRouteMap`.

**Internal only:** The storage functions in `route-map-builder.ts` (`getGlobalRouteMap`,
`getRouterManifest`, `clearCachedManifest`, etc.) are exported from `@rangojs/router/server`
but marked `@internal`. They are consumed by the virtual module and internal Vite plugin
code only. User-land code should use `ctx.reverse()` or `href()` to resolve route names —
never access the manifest storage directly.

## Testing

### Unit tests

```bash
pnpm --filter @rangojs/router exec vitest run
```

- `src/build/__tests__/generate-route-types.test.ts` -- static parser, `writeCombinedRouteTypes`, `preserveIfLarger`
- `src/build/__tests__/generate-manifest.test.ts` -- runtime manifest generation
- `src/build/__tests__/per-router-manifest.test.ts` -- multi-router isolation, lazy loading

### E2E tests

```bash
pnpm --filter @rangojs/router exec playwright test route-types-hmr
pnpm --filter @rangojs/router exec playwright test route-types
pnpm --filter @rangojs/router exec playwright test reverse
```

- `e2e/route-types-hmr.test.ts` -- HMR: add/remove/rename routes, search schema, include, gen file deletion recovery, reverse() sync
- `e2e/route-types.test.ts` -- gen file content in dev and production
- `e2e/reverse.test.ts` -- `ctx.reverse()`, `href()`, mount context in dev and production
- `e2e/reverse-fallback.test.ts` -- module-level `reverse()` via `NamedRoutes` fallback

### Full suite

```bash
pnpm test  # unit tests run first, then e2e
```
