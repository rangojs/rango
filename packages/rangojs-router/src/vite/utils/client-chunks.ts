// Resolution of the public `clientChunks` option into the callback shape that
// @vitejs/plugin-rsc expects. See plugin-types.ts (ClientChunks) and
// docs/client-chunking.md for the contract. The mechanism: a distinct returned
// name yields a distinct, dynamically-imported client chunk, independent of how
// the RSC/server build chunked the importing modules.

import type { ClientChunkMeta, ClientChunks } from "../plugin-types.js";

/** The callback shape @vitejs/plugin-rsc's `clientChunks` option accepts. */
export type RscClientChunksFn = (meta: ClientChunkMeta) => string | undefined;

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
 * 1. If the path passes through a {@link ROUTE_ROOT_DIRS} marker that has a
 *    directory after it, key on that next segment (the route id) — robust to any
 *    nesting depth below it (`routes/foo/components/ui/X.tsx` -> `app-foo`).
 * 2. Otherwise return `undefined` (inherit the default `serverChunk` grouping).
 */
export function directoryClientChunks(
  meta: ClientChunkMeta,
): string | undefined {
  if (isSharedRuntime(meta)) return undefined;
  const segments = meta.normalizedId.split("/").filter(Boolean);
  const dirCount = segments.length - 1; // exclude the filename
  if (dirCount < 1) return undefined;
  // Route-root marker -> the segment after it is the route id. First marker wins,
  // so a top-level route owns its whole subtree. The `< dirCount - 1` bound
  // guarantees the segment after the marker is a directory, not the file.
  for (let i = 0; i < dirCount - 1; i++) {
    if (ROUTE_ROOT_DIRS.has(segments[i].toLowerCase())) {
      return `app-${sanitizeGroup(segments[i + 1])}`;
    }
  }
  // No recognized route structure -> inherit the default serverChunk grouping.
  return undefined;
}

/**
 * Resolve a Rango `clientChunks` option into a @vitejs/plugin-rsc `clientChunks`
 * callback, or `undefined` to leave plugin-rsc on its default (serverChunk)
 * grouping.
 *
 * - `false` / `undefined` -> `undefined` (no override).
 * - `true`               -> the built-in {@link directoryClientChunks} strategy.
 * - function             -> the user's function, used verbatim.
 */
export function resolveClientChunks(
  option: ClientChunks | undefined,
): RscClientChunksFn | undefined {
  if (!option) return undefined;
  if (option === true) return directoryClientChunks;
  return option;
}
