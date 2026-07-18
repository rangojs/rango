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
import {
  isIncludeProvider,
  resolveIncludeModule,
  type IncludeProvider,
} from "../urls/include-provider.js";

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
async function mergeIncludeNodes(
  target: Record<string, PrefixTreeNode>,
  includes: TrackedInclude[],
  buildChild: (include: TrackedInclude) => Promise<PrefixTreeNode>,
): Promise<void> {
  for (const include of includes) {
    let node: PrefixTreeNode;
    try {
      node = await buildChild(include);
    } catch (err) {
      // Discovery (build-time, and the dev trie-rebuild) populates the
      // manifest / trie / generated types for the WHOLE app. A failing async
      // include provider here — a broken import, a module that throws at eval —
      // must HARD-FAIL, not be swallowed: swallowing produces a green build with
      // the entire route group silently absent from the manifest/trie/types, so
      // CI passes, the deploy ships, and every one of that group's URLs then
      // 404s/500s in production. On main an eager include that threw failed the
      // build loudly; the async form must keep that contract. Rethrow with the
      // offending prefix so the failure is actionable. (Sibling isolation
      // belongs at PER-REQUEST runtime — see find-match.ts — not at discovery.)
      throw new Error(
        `[@rangojs/router] Failed to resolve include at prefix "${include.fullPrefix}" ` +
          `during route discovery: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
    const existing = target[include.fullPrefix];
    if (existing) {
      existing.routes.push(...node.routes);
      Object.assign(existing.children, node.children);
    } else {
      target[include.fullPrefix] = node;
    }
  }
}

async function buildPrefixTreeNode(
  urlPrefix: string,
  namePrefix: string | undefined,
  patternsOrProvider: UrlPatterns<any> | IncludeProvider<any>,
  routeManifest: Record<string, string>,
  mountIndex: number,
  visited: Set<unknown> = new Set(),
  routeTrailingSlash?: Record<string, string>,
  prerenderRoutes?: string[],
  prerenderDefs?: Record<string, any>,
  passthroughRoutes?: string[],
  responseTypeRoutes?: Record<string, string>,
  routeSearchSchemas?: Record<string, Record<string, string>>,
  routerId?: string,
  collectEntries?: ManifestEntryCollector,
  inheritedAncestors: readonly EntryData[] = [],
): Promise<PrefixTreeNode> {
  // Resolve an async include provider (`() => import("./routes")`) so its routes
  // are walked into the build-time manifest/types/href. Runtime matching still
  // defers the import via lazy-includes; this only runs during build/dev
  // discovery, which is async.
  const patterns: UrlPatterns<any> = isIncludeProvider(patternsOrProvider)
    ? resolveIncludeModule(await patternsOrProvider(), urlPrefix)
    : patternsOrProvider;
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
  try {
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
        ...(routerId ? { routerId } : {}),
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

    collectEntries?.(manifest, inheritedAncestors);

    // Collect route names defined in this include (routes have prefixes applied)
    const routes = [...patternsMap.keys()];
    Object.assign(routeManifest, Object.fromEntries(patternsMap));

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
    await mergeIncludeNodes(children, trackedIncludes, (include) => {
      const localAncestors: EntryData[] = [];
      for (let entry = include.parent; entry; entry = entry.parent) {
        localAncestors.unshift(entry);
      }
      // Every discovery evaluation creates a synthetic MapRootLayout. It is
      // transport scaffolding, not a declaration in the consumer's route tree.
      if (localAncestors[0]?.parent === null) localAncestors.shift();
      return buildPrefixTreeNode(
        include.fullPrefix,
        include.namePrefix,
        include.patterns as UrlPatterns<any> | IncludeProvider<any>,
        routeManifest,
        mountIndex,
        visited,
        routeTrailingSlash,
        prerenderRoutes,
        prerenderDefs,
        passthroughRoutes,
        responseTypeRoutes,
        routeSearchSchemas,
        routerId,
        collectEntries,
        [...inheritedAncestors, ...localAncestors],
      );
    });

    return {
      staticPrefix: extractStaticPrefix(urlPrefix),
      fullPrefix: urlPrefix,
      namePrefix: namePrefix || undefined,
      children,
      routes,
    };
  } finally {
    // Remove from visited so sibling branches can reuse the same patterns without
    // false circular-include detection — and so a throwing handler (caught by the
    // parent mergeIncludeNodes) does not leak this entry into the shared set.
    visited.delete(patterns);
  }
}

/**
 * Internal manifest result including build-pipeline-only fields.
 * Not part of the public API — use generateManifest() for the public surface.
 */
export interface FullManifest extends GeneratedManifest {
  _prerenderDefs?: Record<string, any>;
}

export type ManifestEntryCollector = (
  entries: ReadonlyMap<string, EntryData>,
  inheritedAncestors: readonly EntryData[],
) => void;

/**
 * Generate manifest from UrlPatterns (public API).
 *
 * Returns only the public GeneratedManifest fields. Internal build pipeline
 * consumers that need _prerenderDefs should use generateManifestFull() instead.
 *
 * @example
 * ```typescript
 * import { generateManifest } from "@rangojs/router/build";
 * import { urlpatterns } from "./urls";
 *
 * // Async: awaits async include() providers (`() => import("./routes")`).
 * const manifest = await generateManifest(urlpatterns);
 * // Write to file for runtime use
 * fs.writeFileSync(
 *   "src/generated/route-manifest.json",
 *   JSON.stringify(manifest, null, 2)
 * );
 * ```
 */
export async function generateManifest<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>,
  mountIndex: number = 0,
): Promise<GeneratedManifest> {
  const { _prerenderDefs, ...publicManifest } = await generateManifestFull(
    urlpatterns,
    mountIndex,
  );
  return publicManifest;
}

/**
 * Generate manifest with internal build-pipeline fields.
 *
 * Used by the Vite plugin (discover-routers via dynamic import through
 * @rangojs/router/build), manifest-init (direct import), and trie
 * building. Not intended for external use.
 */
export async function generateManifestFull<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>,
  mountIndex: number = 0,
  options?: {
    urlPrefix?: string;
    /**
     * Owning router id. Threaded into the evaluation store so path() scopes
     * its search-schema/root-scope registrations per router — same-named
     * routes in different routers must not clobber each other.
     */
    routerId?: string;
    /**
     * Called once per `"use client"` component registered as an
     * errorBoundary/notFoundBoundary fallback, with its client-reference key
     * (`$$id`). Lets the build collect fallback module ids for dedicated
     * chunking without exposing the otherwise-discarded EntryData tree. The
     * EntryData map built below is local; this is the only seam that surfaces it.
     */
    collectClientFallbackRef?: (refKey: string) => void;
    /**
     * Development-discovery seam for projecting route declarations while the
     * local EntryData map still exists. Callers must immediately convert values
     * to plain data; retaining handlers, stores, predicates, or React nodes is
     * unsupported.
     */
    collectEntries?: ManifestEntryCollector;
  },
): Promise<FullManifest> {
  const routeManifest: Record<string, string> = {};
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
      ...(options?.routerId ? { routerId: options.routerId } : {}),
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

  options?.collectEntries?.(manifest, []);

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
  Object.assign(routeManifest, Object.fromEntries(patternsMap));
  const routeTrailingSlash: Record<string, string> =
    Object.fromEntries(trailingSlashMap);
  const routeSearchSchemas: Record<
    string,
    Record<string, string>
  > = Object.fromEntries(searchSchemasMap);

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
      if (entry.isPassthrough === true) {
        passthroughRoutes.push(name);
      }
    }
    if (entry.type === "route" && entry.responseType) {
      responseTypeRoutes[name] = entry.responseType;
    }
  }

  // Shared visited set for cycle detection across all root-level includes.
  const visited = new Set<unknown>();
  await mergeIncludeNodes(prefixTree, trackedIncludes, (include) =>
    buildPrefixTreeNode(
      include.fullPrefix,
      include.namePrefix,
      include.patterns as UrlPatterns<any> | IncludeProvider<any>,
      routeManifest,
      mountIndex,
      visited,
      routeTrailingSlash,
      prerenderRoutes,
      prerenderDefs,
      passthroughRoutes,
      responseTypeRoutes,
      routeSearchSchemas,
      options?.routerId,
      options?.collectEntries,
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
    responseTypeRoutes:
      Object.keys(responseTypeRoutes).length > 0
        ? responseTypeRoutes
        : undefined,
    routeSearchSchemas:
      Object.keys(routeSearchSchemas).length > 0
        ? routeSearchSchemas
        : undefined,
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
 * const code = await generateManifestCode(urlpatterns);
 * fs.writeFileSync("src/generated/route-manifest.ts", code);
 * ```
 */
export async function generateManifestCode<TEnv>(
  urlpatterns: UrlPatterns<TEnv, any>,
): Promise<string> {
  const manifest = await generateManifest(urlpatterns);

  return `/**
 * Auto-generated route manifest
 *
 * DO NOT EDIT - This file is generated by @rangojs/router
 */

export const routeManifest = ${JSON.stringify(manifest.routeManifest, null, 2)} as const;

export type RouteNames = keyof typeof routeManifest;
`;
}
