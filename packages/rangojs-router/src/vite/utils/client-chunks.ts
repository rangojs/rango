// Resolution of the public `clientChunks` option into the callback shape that
// @vitejs/plugin-rsc expects. See plugin-types.ts (ClientChunks) and
// docs/client-chunking.md for the contract. The mechanism: a distinct returned
// name yields a distinct, dynamically-imported client chunk, independent of how
// the RSC/server build chunked the importing modules.

import type { ClientChunkMeta, ClientChunks } from "../plugin-types.js";
import { createRangoDebugger, NS } from "../debug.js";
import { hashRefKey } from "../plugins/client-ref-hashing.js";

/** The callback shape @vitejs/plugin-rsc's `clientChunks` option accepts. */
export type RscClientChunksFn = (meta: ClientChunkMeta) => string | undefined;

/**
 * Build-time context the discovery pass populates and the built-in strategy
 * reads. It refines how the catch-all (no route-root marker) modules are grouped
 * without touching marker splits or the shared runtime:
 *
 * - `fallbackRefs`: production hashes of the `"use client"` modules a consumer
 *   registered as `errorBoundary`/`notFoundBoundary` fallbacks. Pulled into a
 *   dedicated `app-fallback` chunk so the error UI is not co-bundled with the
 *   very route code it exists to catch failures for (resilience), and so the
 *   chunk it would otherwise sit in gets named after a real module rather than
 *   the boundary. Populated by reading each fallback element's client-reference
 *   `$$id` during discovery (see discover-routers).
 */
export interface ClientChunkContext {
  fallbackRefs: Set<string>;
}

/**
 * Opt-in observability for the built-in strategy. The route-root marker list is
 * intentionally finite (see {@link ROUTE_ROOT_DIRS}); a consumer whose layout
 * has no recognized marker (e.g. `src/parts/<feature>/…`) silently inherits the
 * default grouping (no per-route split). That silence is the only real downside
 * of a convention-based default, so we make the decision observable: run a build
 * with `DEBUG=rango:chunks` to see, per client module, which route group it was
 * assigned to or why it fell back to the shared grouping. Zero cost when off
 * (the debugger is `undefined` unless the namespace is enabled). For full control
 * over any layout, pass a `clientChunks` function instead of relying on the
 * convention — that is the supported configurability path, not widening the list.
 */
const debugChunks = createRangoDebugger(NS.chunks);

/**
 * Modules that must stay on the default (shared) grouping regardless of strategy:
 * React, the router client runtime, and anything in node_modules. Splitting these
 * out per route would fragment the shared baseline and regress cache reuse — they
 * are loaded on every route, so they belong in shared chunks.
 *
 * The Rango runtime is matched by package root only: `@rangojs/router` (the
 * installed/aliased name) and the workspace `packages/(rangojs-router|rsc-router)/(src|dist)/`.
 * The `(src|dist)` anchor matches the package's own source/build output but NOT
 * consumer apps that merely live under a `packages/rangojs-router/` ancestor (the
 * in-repo e2e apps), so their app components remain splittable. We deliberately do
 * NOT match a bare `/src/browser/`: that is a consumer-owned path (a consumer's own
 * `src/browser/Foo.tsx` must still split).
 *
 * We test BOTH `meta.id` (absolute) and `meta.normalizedId`. `normalizedId` is the
 * project-root-relative form plugin-rsc derives (e.g. `../../src/browser/react/Link.tsx`
 * for the in-repo runtime), which the package-root patterns miss; the absolute `id`
 * always contains the package's real location, so it reliably catches the runtime.
 */
function isSharedRuntime(meta: ClientChunkMeta): boolean {
  return [meta.id, meta.normalizedId].some(
    (path) =>
      path.includes("/node_modules/") ||
      /\/@rangojs\/router\//.test(path) ||
      /\/packages\/(rangojs-router|rsc-router)\/(src|dist)\//.test(path),
  );
}

/** Sanitize a raw group name into a filesystem/Rollup-safe chunk name fragment. */
function sanitizeGroup(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "app";
}

/**
 * Directory names that conventionally hold one sub-directory per route/feature.
 * When a `"use client"` module lives under one of these, the built-in strategy
 * keys the chunk on the segment IMMEDIATELY AFTER the marker (the route id),
 * rather than the module's immediate parent directory. This is what keeps
 * `routes/foo/components/Button.tsx` and `routes/bar/components/Button.tsx` in
 * `app-foo` / `app-bar` instead of colliding in a single `app-components`.
 *
 * Route identity lives in the path PREFIX; the immediate parent (a suffix) is
 * only a reliable proxy for the un-nested `routes/<route>/Widget.tsx` layout.
 */
const ROUTE_ROOT_DIRS = new Set([
  "routes",
  "route",
  "pages",
  "page",
  "app",
  "features",
  "feature",
  "views",
  "view",
  "handlers",
  "urls",
  "modules",
  "screens",
  "sections",
]);

/**
 * Built-in strategy used when `clientChunks: true` (also the default). Splits app
 * client components by route/feature identity ONLY where it can recognize a route
 * structure; everywhere else it inherits the default grouping (returns undefined).
 * This conservatism is what makes it safe as a default:
 *
 * - A recognized route structure (`routes/<id>/…`, `app/<id>/…`, `handlers/<id>/…`
 *   etc.) splits into a per-route chunk `app-<id>`, at any nesting depth.
 * - A flat `src/components/Button.tsx`, or host sub-apps already split by a dynamic
 *   `import()` boundary (each app's `serverChunk` differs), get `undefined` and so
 *   keep `@vitejs/plugin-rsc`'s default `serverChunk` grouping — i.e. NO change
 *   versus not enabling the option. Returning a parent-dir name here would instead
 *   merge unrelated modules (e.g. every host app's `components/Layout.tsx` into one
 *   `app-components`), re-introducing cross-app leakage.
 *
 * Resolution order:
 * 1. Shared runtime (React / router / node_modules) -> `undefined` (never split).
 * 2. A registered error/notFound fallback (`ctx.fallbackRefs`) -> `app-fallback`,
 *    regardless of location, so the error UI is decoupled from the happy path.
 * 3. A {@link ROUTE_ROOT_DIRS} marker with a directory after it -> key on that
 *    next segment (the route id), robust to any nesting depth.
 * 4. Otherwise `undefined` (inherit the default `serverChunk` grouping).
 */
export function directoryClientChunks(
  meta: ClientChunkMeta,
  ctx?: ClientChunkContext,
): string | undefined {
  if (isSharedRuntime(meta)) {
    // React / router runtime / node_modules: always shared, expected, uninteresting.
    return undefined;
  }
  // Registered error/notFound fallbacks -> a dedicated chunk. The error UI must
  // not co-bundle with the code it catches failures for, and removing it lets the
  // chunk it would otherwise anchor be named after a real module, not the boundary.
  if (
    ctx?.fallbackRefs.size &&
    ctx.fallbackRefs.has(hashRefKey(meta.normalizedId))
  ) {
    debugChunks?.("fallback %s -> app-fallback", meta.normalizedId);
    return "app-fallback";
  }
  const segments = meta.normalizedId.split("/").filter(Boolean);
  const dirCount = segments.length - 1; // exclude the filename
  if (dirCount >= 1) {
    // Route-root marker -> the segment after it is the route id. First marker
    // wins, so a top-level route owns its whole subtree. The `< dirCount - 1`
    // bound guarantees the segment after the marker is a directory, not the file.
    for (let i = 0; i < dirCount - 1; i++) {
      if (ROUTE_ROOT_DIRS.has(segments[i].toLowerCase())) {
        const group = `app-${sanitizeGroup(segments[i + 1])}`;
        debugChunks?.("split %s -> %s", meta.normalizedId, group);
        return group;
      }
    }
  }
  // No recognized route structure -> inherit the default serverChunk grouping.
  // This is the actionable "silent" case: app code that did NOT split by route.
  // Surface it (under DEBUG=rango:chunks) so a consumer can see their layout
  // missed the convention and either colocate under a marker dir or pass a fn.
  debugChunks?.(
    "shared %s (no route-root marker; inherits default grouping)",
    meta.normalizedId,
  );
  return undefined;
}

/**
 * Resolve a Rango `clientChunks` option into a @vitejs/plugin-rsc `clientChunks`
 * callback, or `undefined` to leave plugin-rsc on its default (serverChunk)
 * grouping.
 *
 * - `false` / `undefined` -> `undefined` (no override).
 * - `true`               -> the built-in {@link directoryClientChunks} strategy,
 *   bound to the discovery-populated {@link ClientChunkContext} (fallback chunk).
 * - function             -> the user's function, used verbatim (full control; the
 *   fallback refinement does not apply — the consumer owns the grouping).
 */
export function resolveClientChunks(
  option: ClientChunks | undefined,
  ctx?: ClientChunkContext,
): RscClientChunksFn | undefined {
  if (!option) return undefined;
  if (option === true) return (meta) => directoryClientChunks(meta, ctx);
  return option;
}
