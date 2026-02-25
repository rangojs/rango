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
import { createRouteHelpers } from "../route-definition.js";
import MapRootLayout from "../server/root-layout.js";

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
  /** Route name → trailing slash mode for trie redirect handling */
  routeTrailingSlash?: Record<string, string>;
  /** Route names using Prerender (for dev-mode Node.js delegation) */
  prerenderRoutes?: string[];
  /** Route names with passthrough: true (handler kept in bundle for live fallback) */
  passthroughRoutes?: string[];
  /** Route name → response type for non-RSC routes */
  responseTypeRoutes?: Record<string, string>;
  /** Route name -> search schema descriptor for typed URL helpers */
  routeSearchSchemas?: Record<string, Record<string, string>>;
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
  routeAncestry: Record<string, string[]>, // internal: feeds trie building, not exported
  mountIndex: number,
  visited: Set<unknown> = new Set(),
  routeTrailingSlash?: Record<string, string>,
  prerenderRoutes?: string[],
  prerenderDefs?: Record<string, any>,
  passthroughRoutes?: string[],
  responseTypeRoutes?: Record<string, string>,
  routeSearchSchemas?: Record<string, Record<string, string>>,
): PrefixTreeNode {
  if (visited.has(patterns)) {
    console.warn(
      `[@rangojs/router] Circular include detected at prefix "${urlPrefix}". Skipping.`,
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
  const searchSchemasMap = new Map<string, Record<string, string>>();
  const trackedIncludes: TrackedInclude[] = [];

  RSCRouterContext.run(
    {
      manifest,
      patterns: patternsMap,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      searchSchemas: searchSchemasMap,
      namespace: "build",
      parent: null,
      counters: {},
      mountIndex,
      trackedIncludes, // Enable nested include tracking
    },
    () => {
      const helpers = createRouteHelpers();
      // Wrap in root layout for correct parent hierarchy (matches runtime)
      helpers.layout(MapRootLayout, () => {
        if (urlPrefix || namePrefix) {
          return runWithPrefixes(urlPrefix, namePrefix, () => {
            return patterns.handler() as AllUseItems[];
          });
        }
        return patterns.handler() as AllUseItems[];
      });
    },
  );

  // Collect route names defined in this include (routes have prefixes applied)
  const routes: string[] = [];
  for (const [name, pattern] of patternsMap.entries()) {
    routes.push(name);
    routeManifest[name] = pattern;
  }

  // Collect trailing slash config
  if (routeTrailingSlash) {
    for (const [name, mode] of trailingSlashMap.entries()) {
      routeTrailingSlash[name] = mode;
    }
  }
  if (routeSearchSchemas) {
    for (const [name, schema] of searchSchemasMap.entries()) {
      routeSearchSchemas[name] = schema;
    }
  }

  // Capture ancestry from manifest entries' parent chains
  captureAncestry(manifest, routeAncestry);

  // Collect prerender route names and handler definitions from manifest entries
  if (prerenderRoutes) {
    for (const [name, entry] of manifest) {
      if (entry.type === "route" && entry.isPrerender) {
        prerenderRoutes.push(name);
        if (prerenderDefs && entry.prerenderDef) {
          prerenderDefs[name] = entry.prerenderDef;
        }
        if (
          passthroughRoutes &&
          entry.prerenderDef?.options?.passthrough === true
        ) {
          passthroughRoutes.push(name);
        }
      }
    }
  }

  // Collect response type routes from manifest entries
  if (responseTypeRoutes) {
    for (const [name, entry] of manifest) {
      if (entry.type === "route" && entry.responseType) {
        responseTypeRoutes[name] = entry.responseType;
      }
    }
  }

  // Build children from tracked nested includes.
  // Multiple includes can share the same fullPrefix (e.g., include("/", patternsA),
  // include("/", patternsB)). Merge their routes instead of overwriting.
  const children: Record<string, PrefixTreeNode> = {};

  for (const include of trackedIncludes) {
    const childNode = buildPrefixTreeNode(
      include.fullPrefix,
      include.namePrefix,
      include.patterns as UrlPatterns<any>,
      routeManifest,
      routeAncestry,
      mountIndex,
      visited,
      routeTrailingSlash,
      prerenderRoutes,
      prerenderDefs,
      passthroughRoutes,
      responseTypeRoutes,
      routeSearchSchemas,
    );

    const existing = children[include.fullPrefix];
    if (existing) {
      existing.routes.push(...childNode.routes);
      Object.assign(existing.children, childNode.children);
    } else {
      children[include.fullPrefix] = childNode;
    }
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
 * Walk parent chains of route entries to extract ancestry shortCodes.
 */
function captureAncestry(
  manifest: Map<string, EntryData>,
  routeAncestry: Record<string, string[]>,
): void {
  for (const [routeName, entry] of manifest) {
    if (entry.type === "route") {
      const ancestry: string[] = [];
      let current: EntryData | null = entry;
      while (current) {
        ancestry.unshift(current.shortCode);
        current = current.parent;
      }
      routeAncestry[routeName] = ancestry;
    }
  }
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
  urlpatterns: UrlPatterns<TEnv, any>,
  mountIndex: number = 0,
): GeneratedManifest & {
  _routeAncestry: Record<string, string[]>;
  _prerenderDefs?: Record<string, any>;
} {
  const routeManifest: Record<string, string> = {};
  const routeAncestry: Record<string, string[]> = {};
  const prefixTree: Record<string, PrefixTreeNode> = {};

  // Run the root patterns handler with tracking enabled
  const manifest = new Map<string, EntryData>();
  const patternsMap = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, TrailingSlashMode>();
  const searchSchemasMap = new Map<string, Record<string, string>>();
  const trackedIncludes: TrackedInclude[] = [];

  RSCRouterContext.run(
    {
      manifest,
      patterns: patternsMap,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      searchSchemas: searchSchemasMap,
      namespace: "build",
      parent: null,
      counters: {},
      mountIndex,
      trackedIncludes, // Enable include tracking
    },
    () => {
      const helpers = createRouteHelpers();
      // Wrap in root layout for correct parent hierarchy (matches runtime)
      helpers.layout(MapRootLayout, () => {
        return urlpatterns.handler() as AllUseItems[];
      });
    },
  );

  // Collect root-level routes and trailing slash config
  const routeTrailingSlash: Record<string, string> = {};
  for (const [name, pattern] of patternsMap.entries()) {
    routeManifest[name] = pattern;
  }
  for (const [name, mode] of trailingSlashMap.entries()) {
    routeTrailingSlash[name] = mode;
  }
  const routeSearchSchemas: Record<string, Record<string, string>> = {};
  for (const [name, schema] of searchSchemasMap.entries()) {
    routeSearchSchemas[name] = schema;
  }

  // Capture ancestry from manifest entries' parent chains
  captureAncestry(manifest, routeAncestry);

  // Collect prerender route names and handler definitions across all levels
  const prerenderRoutes: string[] = [];
  const prerenderDefs: Record<string, any> = {};
  const passthroughRoutes: string[] = [];
  const responseTypeRoutes: Record<string, string> = {};
  for (const [name, entry] of manifest) {
    if (entry.type === "route" && entry.isPrerender) {
      prerenderRoutes.push(name);
      if (entry.prerenderDef) {
        prerenderDefs[name] = entry.prerenderDef;
      }
      if (entry.prerenderDef?.options?.passthrough === true) {
        passthroughRoutes.push(name);
      }
    }
    if (entry.type === "route" && entry.responseType) {
      responseTypeRoutes[name] = entry.responseType;
    }
  }

  // Build prefix tree from tracked includes (shared visited set for cycle detection).
  // Multiple includes can share the same fullPrefix (e.g., include("/", patternsA),
  // include("/", patternsB)). Merge their routes instead of overwriting.
  const visited = new Set<unknown>();
  for (const include of trackedIncludes) {
    const node = buildPrefixTreeNode(
      include.fullPrefix,
      include.namePrefix,
      include.patterns as UrlPatterns<any>,
      routeManifest,
      routeAncestry,
      mountIndex,
      visited,
      routeTrailingSlash,
      prerenderRoutes,
      prerenderDefs,
      passthroughRoutes,
      responseTypeRoutes,
      routeSearchSchemas,
    );

    const existing = prefixTree[include.fullPrefix];
    if (existing) {
      existing.routes.push(...node.routes);
      Object.assign(existing.children, node.children);
    } else {
      prefixTree[include.fullPrefix] = node;
    }
  }

  return {
    prefixTree,
    routeManifest,
    routeTrailingSlash:
      Object.keys(routeTrailingSlash).length > 0
        ? routeTrailingSlash
        : undefined,
    prerenderRoutes: prerenderRoutes.length > 0 ? prerenderRoutes : undefined,
    passthroughRoutes:
      passthroughRoutes.length > 0 ? passthroughRoutes : undefined,
    responseTypeRoutes:
      Object.keys(responseTypeRoutes).length > 0
        ? responseTypeRoutes
        : undefined,
    routeSearchSchemas:
      Object.keys(routeSearchSchemas).length > 0
        ? routeSearchSchemas
        : undefined,
    generatedAt: new Date().toISOString(),
    // Internal: routeAncestry is used only for trie building, not exported
    _routeAncestry: routeAncestry,
    // Internal: prerender handler definitions for build-time getParams() access
    _prerenderDefs:
      Object.keys(prerenderDefs).length > 0 ? prerenderDefs : undefined,
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
  urlpatterns: UrlPatterns<TEnv, any>,
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
