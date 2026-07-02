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
import { RangoContext, runWithPrefixes } from "../server/context.js";
import type { EntryData, TrackedInclude } from "../server/context.js";
import type { TrailingSlashMode } from "../types.js";
import { createRouteHelpers } from "../route-definition.js";
import MapRootLayout from "../server/root-layout.js";
import { collectFallbackClientRefs } from "./collect-fallback-refs.js";

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
  /** Route names wrapped with Passthrough() (live handler for runtime fallback) */
  passthroughRoutes?: string[];
  /** Route names opted into on-demand prerender (Prerender(..., { onDemand })) */
  onDemandRoutes?: string[];
  /** Route name → response type for non-RSC routes */
  responseTypeRoutes?: Record<string, string>;
  /** Route name -> search schema descriptor for typed URL helpers */
  routeSearchSchemas?: Record<string, Record<string, string>>;
}

/**
 * Build prefix tree node by running the patterns with proper context.
 * Uses a visited set to detect circular includes and prevent infinite recursion.
 */
// Merge tracked nested includes into `target`. Multiple includes can share a
// fullPrefix (e.g. include("/", a), include("/", b)) — concat their routes and
// Object.assign children rather than overwrite.
function mergeIncludeNodes(
  target: Record<string, PrefixTreeNode>,
  includes: TrackedInclude[],
  buildChild: (include: TrackedInclude) => PrefixTreeNode,
): void {
  for (const include of includes) {
    const node = buildChild(include);
    const existing = target[include.fullPrefix];
    if (existing) {
      existing.routes.push(...node.routes);
      Object.assign(existing.children, node.children);
    } else {
      target[include.fullPrefix] = node;
    }
  }
}

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
  onDemandRoutes?: string[],
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

  RangoContext.run(
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
        if (passthroughRoutes && entry.isPassthrough === true) {
          passthroughRoutes.push(name);
        }
        if (onDemandRoutes && entry.isOnDemand === true) {
          onDemandRoutes.push(name);
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

  const children: Record<string, PrefixTreeNode> = {};
  mergeIncludeNodes(children, trackedIncludes, (include) =>
    buildPrefixTreeNode(
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
      onDemandRoutes,
      responseTypeRoutes,
      routeSearchSchemas,
    ),
  );

  // Remove from visited so sibling branches can reuse the same patterns
  // without false circular-include detection. Only ancestors in the current
  // recursion path should trigger the cycle guard.
  visited.delete(patterns);

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
 * Internal manifest result including build-pipeline-only fields.
 * Not part of the public API — use generateManifest() for the public surface.
 */
export interface FullManifest extends GeneratedManifest {
  _routeAncestry: Record<string, string[]>;
  _prerenderDefs?: Record<string, any>;
}

/**
 * Generate manifest from UrlPatterns (public API).
 *
 * Returns only the public GeneratedManifest fields. Internal build pipeline
 * consumers that need _routeAncestry or _prerenderDefs should use
 * generateManifestFull() instead.
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
): GeneratedManifest {
  const {
    _routeAncestry: _,
    _prerenderDefs: __,
    ...publicManifest
  } = generateManifestFull(urlpatterns, mountIndex);
  return publicManifest;
}

/**
 * Generate manifest with internal build-pipeline fields.
 *
 * Used by the Vite plugin (discover-routers via dynamic import through
 * @rangojs/router/build), manifest-init (direct import), and trie
 * building. Not intended for external use.
 */
export function generateManifestFull<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>,
  mountIndex: number = 0,
  options?: {
    urlPrefix?: string;
    /**
     * Called once per `"use client"` component registered as an
     * errorBoundary/notFoundBoundary fallback, with its client-reference key
     * (`$$id`). Lets the build collect fallback module ids for dedicated
     * chunking without exposing the otherwise-discarded EntryData tree. The
     * EntryData map built below is local; this is the only seam that surfaces it.
     */
    collectClientFallbackRef?: (refKey: string) => void;
  },
): FullManifest {
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

  RangoContext.run(
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
      // basename sets the initial URL prefix for all path() registrations
      ...(options?.urlPrefix ? { urlPrefix: options.urlPrefix } : {}),
    },
    () => {
      const helpers = createRouteHelpers();
      // Wrap in root layout for correct parent hierarchy (matches runtime)
      helpers.layout(MapRootLayout, () => {
        return urlpatterns.handler() as AllUseItems[];
      });
    },
  );

  // Surface the "use client" components registered as error/notFound fallbacks
  // (route-tree errorBoundary()/notFoundBoundary() helpers, stored on EntryData).
  // The boundary may be a handler function and/or wrap the client boundary in
  // server providers, so walk the whole tree (see collectFallbackClientRefs).
  if (options?.collectClientFallbackRef) {
    const report = options.collectClientFallbackRef;
    const collect = (boundary: unknown[] | undefined) => {
      for (const item of boundary ?? [])
        collectFallbackClientRefs(item, report);
    };
    for (const entry of manifest.values()) {
      collect(entry.errorBoundary);
      collect(entry.notFoundBoundary);
    }
  }

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
  const onDemandRoutes: string[] = [];
  const responseTypeRoutes: Record<string, string> = {};
  for (const [name, entry] of manifest) {
    if (entry.type === "route" && entry.isPrerender) {
      prerenderRoutes.push(name);
      if (entry.prerenderDef) {
        prerenderDefs[name] = entry.prerenderDef;
      }
      if (entry.isPassthrough === true) {
        passthroughRoutes.push(name);
      }
      if (entry.isOnDemand === true) {
        onDemandRoutes.push(name);
      }
    }
    if (entry.type === "route" && entry.responseType) {
      responseTypeRoutes[name] = entry.responseType;
    }
  }

  // Shared visited set for cycle detection across all root-level includes.
  const visited = new Set<unknown>();
  mergeIncludeNodes(prefixTree, trackedIncludes, (include) =>
    buildPrefixTreeNode(
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
      onDemandRoutes,
      responseTypeRoutes,
      routeSearchSchemas,
    ),
  );

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
    onDemandRoutes: onDemandRoutes.length > 0 ? onDemandRoutes : undefined,
    responseTypeRoutes:
      Object.keys(responseTypeRoutes).length > 0
        ? responseTypeRoutes
        : undefined,
    routeSearchSchemas:
      Object.keys(routeSearchSchemas).length > 0
        ? routeSearchSchemas
        : undefined,
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
 *
 * DO NOT EDIT - This file is generated by @rangojs/router
 */

export const routeManifest = ${JSON.stringify(manifest.routeManifest, null, 2)} as const;

export type RouteNames = keyof typeof routeManifest;
`;
}
