/**
 * assertGeneratedRoutesMatch — pin the generated named-routes map against the
 * router's runtime route map.
 *
 * The Vite plugin writes a `*.named-routes.gen.ts` file mapping route names to
 * URL patterns; consumers import that map and pass it here. The check compares
 * it to the router's runtime `routeMap`, catching drift when a route is added,
 * removed, renamed, or its pattern changes without regenerating the file.
 *
 * Directionality (relative to the generated map):
 * - missing:  present in the generated map but NOT at runtime (stale entry).
 * - extra:    present at runtime but NOT in the generated map (ungenerated route).
 * - mismatch: present in both under the same name, but the patterns differ.
 *
 * When `generatedMap` is omitted, the global route map (getGlobalRouteMap()) is
 * used as the generated side — useful when a single router has registered into
 * the global map.
 */

import { getGlobalRouteMap } from "../route-map-builder.js";

/**
 * Router shape this check depends on: just a runtime route map.
 */
interface RouterWithRouteMap {
  routeMap: Record<string, unknown>;
}

/**
 * A single name/pattern mismatch: [routeName, generatedPattern, runtimePattern].
 */
export type GeneratedRouteMismatch = [
  name: string,
  generated: string,
  runtime: string,
];

/**
 * Structured diff between the generated route map and the runtime route map.
 */
export interface GeneratedRoutesDiff {
  /** Names in the generated map but absent at runtime. */
  missing: string[];
  /** Names at runtime but absent from the generated map. */
  extra: string[];
  /** Names in both with differing patterns. */
  mismatch: GeneratedRouteMismatch[];
  /** True when missing, extra, and mismatch are all empty. */
  ok: boolean;
}

/**
 * Normalize a route map value to its pattern string. Route maps may carry
 * either a bare pattern string or a `{ path, ... }` object (for response/search
 * routes); compare on the `path`.
 */
function patternOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "path" in value &&
    typeof (value as { path: unknown }).path === "string"
  ) {
    return (value as { path: string }).path;
  }
  return String(value);
}

/**
 * Compute the diff between a router's runtime route map and a generated map.
 */
export function diffGeneratedRoutes(
  router: RouterWithRouteMap,
  generatedMap?: Record<string, unknown>,
): GeneratedRoutesDiff {
  const runtime = router.routeMap as Record<string, unknown>;
  const generated = generatedMap ?? getGlobalRouteMap();

  const missing: string[] = [];
  const extra: string[] = [];
  const mismatch: GeneratedRouteMismatch[] = [];

  for (const name of Object.keys(generated)) {
    if (!(name in runtime)) {
      missing.push(name);
      continue;
    }
    const gen = patternOf(generated[name]);
    const run = patternOf(runtime[name]);
    if (gen !== run) {
      mismatch.push([name, gen, run]);
    }
  }

  for (const name of Object.keys(runtime)) {
    if (!(name in generated)) {
      extra.push(name);
    }
  }

  return {
    missing,
    extra,
    mismatch,
    ok: missing.length === 0 && extra.length === 0 && mismatch.length === 0,
  };
}

/**
 * Assert the router's runtime route map matches the generated map. Throws a
 * descriptive Error listing every missing, extra, and mismatched route when
 * they diverge.
 *
 * @example
 * ```ts
 * import generated from "./router.named-routes.gen";
 * import { router } from "./router";
 *
 * assertGeneratedRoutesMatch(router, generated);
 * ```
 */
export function assertGeneratedRoutesMatch(
  router: RouterWithRouteMap,
  generatedMap?: Record<string, unknown>,
): void {
  const diff = diffGeneratedRoutes(router, generatedMap);
  if (diff.ok) return;

  const lines: string[] = [
    "Generated routes do not match the router's runtime route map.",
  ];

  if (diff.missing.length > 0) {
    lines.push(
      `  Missing (generated but not at runtime): ${diff.missing.join(", ")}`,
    );
  }
  if (diff.extra.length > 0) {
    lines.push(
      `  Extra (at runtime but not generated): ${diff.extra.join(", ")}`,
    );
  }
  if (diff.mismatch.length > 0) {
    lines.push("  Pattern mismatches (name: generated -> runtime):");
    for (const [name, gen, run] of diff.mismatch) {
      lines.push(`    ${name}: ${gen} -> ${run}`);
    }
  }
  lines.push(
    "Re-run the build / `rango` route generation to regenerate the *.named-routes.gen.ts file.",
  );

  throw new Error(lines.join("\n"));
}
