/**
 * Build-time manifest generation for @rangojs/router
 *
 * Extracts the prefix tree and route manifest from UrlPatterns at build time.
 * This enables:
 * - Pre-computed prefix tree for fast short-circuit checks
 * - Complete route manifest for href() without runtime evaluation
 * - Support for nested includes
 */

import type { UrlPatterns } from "../urls.js";
import type { AllUseItems } from "../route-types.js";
import { extractStaticPrefix } from "../router/pattern-matching.js";
import { RSCRouterContext, runWithPrefixes } from "../server/context.js";
import type { EntryData, TrackedInclude } from "../server/context.js";
import type { TrailingSlashMode } from "../types.js";

/**
 * Node in the prefix tree
 */
export interface PrefixTreeNode {
  /** The static prefix for this node */
  staticPrefix: string;
  /** The full URL prefix (including parent prefixes) */
  fullPrefix: string;
  /** Name prefix for routes in this include */
  namePrefix?: string;
  /** Child nodes (nested includes) */
  children: Record<string, PrefixTreeNode>;
  /** Route names defined directly in this include (not in children) */
  routes: string[];
}

/**
 * Generated manifest containing prefix tree and route mappings
 */
export interface GeneratedManifest {
  /** Nested prefix tree for short-circuit optimization */
  prefixTree: Record<string, PrefixTreeNode>;
  /** Complete route name → pattern mapping for href() */
  routeManifest: Record<string, string>;
  /** Generation timestamp */
  generatedAt: string;
}

/**
 * Build prefix tree node by running the patterns with proper context.
 * Uses a visited set to detect circular includes and prevent infinite recursion.
 */
function buildPrefixTreeNode(
  urlPrefix: string,
  namePrefix: string | undefined,
  patterns: UrlPatterns<any>,
  routeManifest: Record<string, string>,
  visited: Set<unknown> = new Set()
): PrefixTreeNode {
  if (visited.has(patterns)) {
    console.warn(
      `[@rangojs/router] Circular include detected at prefix "${urlPrefix}". Skipping.`
    );
    return {
      staticPrefix: extractStaticPrefix(urlPrefix),
      fullPrefix: urlPrefix,
      namePrefix: namePrefix || undefined,
      children: {},
      routes: [],
    };
  }
  visited.add(patterns);
  // Create context for running patterns with include tracking
  const manifest = new Map<string, EntryData>();
  const patternsMap = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, TrailingSlashMode>();
  const trackedIncludes: TrackedInclude[] = [];

  RSCRouterContext.run(
    {
      manifest,
      patterns: patternsMap,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      namespace: "build",
      parent: null,
      counters: {},
      trackedIncludes, // Enable nested include tracking
    },
    () => {
      // Run patterns with the URL and name prefixes
      runWithPrefixes(urlPrefix, namePrefix, () => {
        return patterns.handler() as AllUseItems[];
      });
    }
  );

  // Collect route names defined in this include (routes have prefixes applied)
  const routes: string[] = [];
  for (const [name, pattern] of patternsMap.entries()) {
    routes.push(name);
    routeManifest[name] = pattern;
  }

  // Build children from tracked nested includes
  const children: Record<string, PrefixTreeNode> = {};

  for (const include of trackedIncludes) {
    const childNode = buildPrefixTreeNode(
      include.fullPrefix,
      include.namePrefix,
      include.patterns as UrlPatterns<any>,
      routeManifest,
      visited
    );

    children[include.fullPrefix] = childNode;
  }

  return {
    staticPrefix: extractStaticPrefix(urlPrefix),
    fullPrefix: urlPrefix,
    namePrefix: namePrefix || undefined,
    children,
    routes,
  };
}

/**
 * Generate manifest from UrlPatterns
 *
 * This runs all patterns (including lazy ones) at build time to extract:
 * - The complete prefix tree for short-circuit optimization
 * - The complete route manifest for href()
 *
 * @example
 * ```typescript
 * import { generateManifest } from "@rangojs/router/build";
 * import { urlpatterns } from "./urls";
 *
 * const manifest = generateManifest(urlpatterns);
 * // Write to file for runtime use
 * fs.writeFileSync(
 *   "src/generated/route-manifest.json",
 *   JSON.stringify(manifest, null, 2)
 * );
 * ```
 */
export function generateManifest<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>
): GeneratedManifest {
  const routeManifest: Record<string, string> = {};
  const prefixTree: Record<string, PrefixTreeNode> = {};

  // Run the root patterns handler with tracking enabled
  const manifest = new Map<string, EntryData>();
  const patternsMap = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, TrailingSlashMode>();
  const trackedIncludes: TrackedInclude[] = [];

  RSCRouterContext.run(
    {
      manifest,
      patterns: patternsMap,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      namespace: "build",
      parent: null,
      counters: {},
      trackedIncludes, // Enable include tracking
    },
    () => {
      urlpatterns.handler();
    }
  );

  // Collect root-level routes
  for (const [name, pattern] of patternsMap.entries()) {
    routeManifest[name] = pattern;
  }

  // Build prefix tree from tracked includes (shared visited set for cycle detection)
  const visited = new Set<unknown>();
  for (const include of trackedIncludes) {
    const node = buildPrefixTreeNode(
      include.fullPrefix,
      include.namePrefix,
      include.patterns as UrlPatterns<any>,
      routeManifest,
      visited
    );

    prefixTree[include.fullPrefix] = node;
  }

  return {
    prefixTree,
    routeManifest,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate TypeScript code for the manifest
 *
 * @example
 * ```typescript
 * const code = generateManifestCode(urlpatterns);
 * fs.writeFileSync("src/generated/route-manifest.ts", code);
 * ```
 */
export function generateManifestCode<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>
): string {
  const manifest = generateManifest(urlpatterns);

  return `/**
 * Auto-generated route manifest
 * Generated at: ${manifest.generatedAt}
 *
 * DO NOT EDIT - This file is generated by @rangojs/router
 */

export const routeManifest = ${JSON.stringify(manifest.routeManifest, null, 2)} as const;

export type RouteNames = keyof typeof routeManifest;
`;
}
