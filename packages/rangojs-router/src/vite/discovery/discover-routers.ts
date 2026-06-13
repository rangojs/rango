/**
 * Router Discovery
 *
 * Core discovery logic: imports the user's entry file via the RSC
 * environment's module runner, generates manifests for each discovered
 * router, and builds route tries for O(path_length) matching.
 */

import {
  buildCombinedRouteMapForRouterFile,
  formatNestedRouterConflictError,
  findNestedRouterConflict,
} from "../../build/generate-route-types.js";
// Pure data transforms over generateManifestFull's output. Imported directly
// from source (not the public ./build barrel, and not the runner) because they
// are realm-independent: buildRouteTrie/buildPerRouterTrie operate on plain
// manifest data, and collectFallbackClientRefs keys on the global-registry
// Symbol.for("react.client.reference"), so it detects client references in a
// boundary tree regardless of which realm imported the walker. Only
// generateManifestFull must stay on the runner (it invokes user handlers via
// RangoContext from the runner realm) — see the runner.import below.
import { buildRouteTrie, buildPerRouterTrie } from "../../build/route-trie.js";
import { collectFallbackClientRefs } from "../../build/collect-fallback-refs.js";
import {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
} from "../utils/manifest-utils.js";
import type { DiscoveryState, PrecomputedEntry } from "./state.js";
import {
  expandPrerenderRoutes,
  renderStaticHandlers,
} from "./prerender-collection.js";
import {
  resolveHostRouterHandlers,
  DiscoveryError,
  type CaughtDiscoveryError,
} from "./discovery-errors.js";
import { createRangoDebugger, timed, NS } from "../debug.js";
import { computeProductionHash } from "../plugins/client-ref-hashing.js";

const debug = createRangoDebugger(NS.discovery);

/**
 * Import the user's entry via RSC runner, generate manifests for each
 * discovered router, build route tries, and optionally run prerender
 * expansion and static handler rendering (build mode only).
 *
 * Returns the imported `@rangojs/router/server` module so the caller
 * can access the RouterRegistry and manifest setters.
 */
export async function discoverRouters(
  state: DiscoveryState,
  rscEnv: any,
): Promise<any> {
  if (!state.resolvedEntryPath) return;

  // Import the entry file via RSC environment.
  // For node preset: this is the router file (createRouter() registers in RouterRegistry).
  // For cloudflare preset: this is the worker entry (which imports the router).
  await timed(debug, "inner: import entry", () =>
    rscEnv.runner.import(state.resolvedEntryPath),
  );

  // Import the router package to access the registry
  const serverMod = await timed(
    debug,
    "inner: import @rangojs/router/server",
    () => rscEnv.runner.import("@rangojs/router/server"),
  );
  let registry: Map<string, any> = serverMod.RouterRegistry;

  if (!registry || registry.size === 0) {
    // No RSC routers found directly. Check for host routers with lazy handlers
    // that need to be resolved to trigger sub-app createRouter() calls.
    //
    // Handler failures are collected rather than swallowed: when the registry
    // is still empty afterwards, these errors (typically a sub-app whose router
    // module failed to import) are the most likely cause and are surfaced in
    // the terminal "No routers found" error below.
    const discoveryErrors: CaughtDiscoveryError[] = [];
    try {
      const hostRegistry: Map<string, any> | undefined =
        serverMod.HostRouterRegistry;

      if (hostRegistry && hostRegistry.size > 0) {
        console.log(
          `[rango] Found ${hostRegistry.size} host router(s), resolving lazy handlers...`,
        );

        const handlerErrors = await resolveHostRouterHandlers(hostRegistry);
        discoveryErrors.push(...handlerErrors);
        for (const { context, error } of handlerErrors) {
          debug?.("caught error while resolving %s: %O", context, error);
        }

        // Re-read RouterRegistry - sub-app createRouter() calls should have populated it
        const freshServerMod = await rscEnv.runner.import(
          "@rangojs/router/server",
        );
        const freshRegistry: Map<string, any> = freshServerMod.RouterRegistry;

        if (freshRegistry && freshRegistry.size > 0) {
          // Update references so the manifest generation below uses the fresh data
          Object.assign(serverMod, freshServerMod);
          registry = freshRegistry;
        }
      }
    } catch (error) {
      // Host-router discovery is best-effort; record the failure so it can be
      // surfaced if no routers are found.
      discoveryErrors.push({ context: "host-router discovery", error });
    }

    // If still no routers after host router resolution, fail
    if (!registry || registry.size === 0) {
      throw new DiscoveryError(state.resolvedEntryPath, discoveryErrors);
    }
  }

  // generateManifestFull must run in the RSC runner realm: it invokes the
  // user's urlpatterns.handler() via RangoContext, consuming router instances
  // from the runner. The trie/fallback-ref builders are pure transforms over
  // its output and are imported directly from source above.
  const buildMod = await timed(
    debug,
    "inner: import @rangojs/router/build",
    () => rscEnv.runner.import("@rangojs/router/build"),
  );
  const generateManifestFull = buildMod.generateManifestFull;

  debug?.("inner: found %d router(s) in registry", registry.size);

  const nestedRouterConflict = findNestedRouterConflict(
    [...registry.values()]
      .map((router) => router.__sourceFile)
      .filter(
        (sourceFile): sourceFile is string => typeof sourceFile === "string",
      ),
  );
  if (nestedRouterConflict) {
    throw new Error(formatNestedRouterConflictError(nestedRouterConflict));
  }

  // Build into local variables first. Only commit to state after the
  // full pass succeeds, so a failed re-discovery preserves the last
  // known-good state instead of leaving it partially wiped.
  const newMergedRouteManifest: Record<string, string> = {};
  const newMergedPrecomputedEntries: PrecomputedEntry[] = [];
  const newPerRouterManifests: typeof state.perRouterManifests = [];
  const newPerRouterManifestDataMap = new Map<string, any>();
  const newPerRouterPrecomputedMap = new Map<string, PrecomputedEntry[]>();
  const newPerRouterTrieMap = new Map<string, any>();
  let mergedRouteAncestry: Record<string, string[]> = {};
  let mergedRouteTrailingSlash: Record<string, string> = {};

  let routerMountIndex = 0;
  // Collect all manifests for trie building (avoid re-running generateManifest)
  const allManifests: Array<{ id: string; manifest: any }> = [];

  // Built-in clientChunks context (present only when the built-in strategy is
  // active). Collect the production hashes of "use client" error/notFound
  // fallback modules so the strategy can route them into app-fallback.
  const clientChunkCtx = state.opts?.clientChunkCtx;
  const collectClientFallbackRef = clientChunkCtx
    ? (refKey: string) =>
        clientChunkCtx.fallbackRefs.add(
          computeProductionHash(state.projectRoot, refKey),
        )
    : undefined;
  // Router-level boundary defaults (`createRouter({ defaultErrorBoundary, ... })`)
  // are NOT in EntryData, so generateManifestFull's walk misses them. Collect any
  // "use client" default boundary directly off the router instance. The value is
  // commonly a handler function wrapping the client boundary in server providers,
  // so collectFallbackClientRefs invokes + walks the tree. The walker keys on the
  // global-registry Symbol.for("react.client.reference"), so it detects client
  // references in a runner-realm boundary tree even when imported here directly.
  const collectFromBoundaryNode = (node: unknown): void => {
    if (collectClientFallbackRef) {
      collectFallbackClientRefs(node, collectClientFallbackRef);
    }
  };

  const manifestGenStart = debug ? performance.now() : 0;
  for (const [id, router] of registry) {
    if (!router.urlpatterns || !generateManifestFull) {
      continue;
    }

    const manifest = generateManifestFull(
      router.urlpatterns,
      routerMountIndex,
      {
        ...(router.__basename ? { urlPrefix: router.__basename } : {}),
        ...(collectClientFallbackRef ? { collectClientFallbackRef } : {}),
      },
    );
    routerMountIndex++;
    allManifests.push({ id, manifest });

    // Router-level "use client" boundary defaults -> app-fallback (the
    // route-tree errorBoundary()/notFoundBoundary() helpers are already
    // collected inside generateManifestFull via collectClientFallbackRef).
    if (collectClientFallbackRef) {
      collectFromBoundaryNode(router.__defaultErrorBoundary);
      collectFromBoundaryNode(router.__defaultNotFoundBoundary);
      collectFromBoundaryNode(router.__notFound);
    }

    const routeCount = Object.keys(manifest.routeManifest).length;
    const staticRoutes = Object.values(manifest.routeManifest).filter(
      (p: any) => !p.includes(":") && !p.includes("*"),
    ).length;
    const dynamicRoutes = routeCount - staticRoutes;

    // Merge into the combined manifest
    Object.assign(newMergedRouteManifest, manifest.routeManifest);

    // Compute factory-only prefixes: dot-prefixed groups in the runtime
    // manifest that the static parser cannot see. These are routes created
    // by factory functions (e.g. createDocsPatterns()) and should always be
    // supplemented on file change since HMR won't re-discover them.
    let factoryOnlyPrefixes: Set<string> | undefined;
    if (router.__sourceFile) {
      const staticParsed = buildCombinedRouteMapForRouterFile(
        router.__sourceFile,
      );
      const staticNames = new Set(Object.keys(staticParsed.routes));
      factoryOnlyPrefixes = new Set<string>();
      for (const name of Object.keys(manifest.routeManifest)) {
        if (staticNames.has(name)) continue;
        const dotIdx = name.indexOf(".");
        if (dotIdx <= 0) continue;
        const prefix = name.substring(0, dotIdx + 1);
        if ([...staticNames].some((n) => n.startsWith(prefix))) continue;
        factoryOnlyPrefixes.add(prefix);
      }
      if (factoryOnlyPrefixes.size === 0) factoryOnlyPrefixes = undefined;
    }

    newPerRouterManifests.push({
      id,
      routeManifest: manifest.routeManifest,
      routeSearchSchemas: manifest.routeSearchSchemas,
      sourceFile: router.__sourceFile,
      factoryOnlyPrefixes,
    });

    // Merge ancestry (internal field, used only for trie building)
    if (manifest._routeAncestry) {
      Object.assign(mergedRouteAncestry, manifest._routeAncestry);
    }
    // Merge trailing slash config
    if (manifest.routeTrailingSlash) {
      Object.assign(mergedRouteTrailingSlash, manifest.routeTrailingSlash);
    }

    // Flatten prefix tree leaf nodes into precomputed entries.
    // Leaf nodes (no children) can have their routes used directly by
    // evaluateLazyEntry() without running the handler at runtime.
    // Walk once into a per-router array, then fold it into the merged array;
    // the merged and per-router entries are identical, so a second walk is
    // redundant. Append order is preserved within and across routers.
    const routerPrecomputed: PrecomputedEntry[] = [];
    flattenLeafEntries(
      manifest.prefixTree,
      manifest.routeManifest,
      routerPrecomputed,
    );
    newMergedPrecomputedEntries.push(...routerPrecomputed);

    // Store per-router manifest and precomputed entries for isolated virtual modules.
    newPerRouterManifestDataMap.set(id, manifest.routeManifest);
    newPerRouterPrecomputedMap.set(id, routerPrecomputed);

    console.log(
      `[rango] Router "${id}" -> ${routeCount} routes ` +
        `(${staticRoutes} static, ${dynamicRoutes} dynamic)`,
    );
  }

  // Warn if multiple routers use auto-generated IDs (router_0, router_1, ...).
  // Auto-IDs are assigned by counter and depend on module evaluation order,
  // which can differ between build time and runtime (especially with dynamic
  // imports in host routers). This causes per-router data to be loaded into
  // the wrong router at runtime.
  if (registry.size > 1) {
    const autoIds = [...registry.keys()].filter((id) =>
      /^router_\d+$/.test(id),
    );
    if (autoIds.length > 1) {
      console.warn(
        `[rango] WARNING: ${autoIds.length} routers use auto-generated IDs (${autoIds.join(", ")}). ` +
          `In multi-router setups, each createRouter() must have an explicit \`id\` option ` +
          `to ensure per-router manifest data is matched correctly at runtime. ` +
          `Example: createRouter({ id: "site", ... })`,
      );
    }
  }

  debug?.(
    "inner: generated manifests for %d router(s) (%sms)",
    allManifests.length,
    (performance.now() - manifestGenStart).toFixed(1),
  );

  // Build route trie from merged manifest + ancestry
  let newMergedRouteTrie: any = null;
  const trieStart = debug ? performance.now() : 0;
  if (Object.keys(newMergedRouteManifest).length > 0) {
    if (mergedRouteAncestry) {
      // Build routeToStaticPrefix from saved manifests
      const routeToStaticPrefix: Record<string, string> = {};
      for (const { manifest } of allManifests) {
        // Root-level routes have empty static prefix
        for (const name of Object.keys(manifest.routeManifest)) {
          if (!(name in routeToStaticPrefix)) {
            routeToStaticPrefix[name] = "";
          }
        }
        buildRouteToStaticPrefix(manifest.prefixTree, routeToStaticPrefix);
      }

      // Collect prerender route names and response type routes from all manifests
      const prerenderRouteNames = new Set<string>();
      const passthroughRouteNames = new Set<string>();
      const mergedResponseTypeRoutes: Record<string, string> = {};
      for (const { manifest } of allManifests) {
        if (manifest.prerenderRoutes) {
          for (const name of manifest.prerenderRoutes) {
            prerenderRouteNames.add(name);
          }
        }
        if (manifest.passthroughRoutes) {
          for (const name of manifest.passthroughRoutes) {
            passthroughRouteNames.add(name);
          }
        }
        if (manifest.responseTypeRoutes) {
          Object.assign(mergedResponseTypeRoutes, manifest.responseTypeRoutes);
        }
      }

      // buildRouteTrie reads these via ?.has / ?.[] — empty is observationally
      // identical to undefined, so no empty->undefined coercion is needed.
      newMergedRouteTrie = buildRouteTrie(
        newMergedRouteManifest,
        mergedRouteAncestry,
        routeToStaticPrefix,
        mergedRouteTrailingSlash,
        prerenderRouteNames,
        passthroughRouteNames,
        mergedResponseTypeRoutes,
      );

      // Build per-router tries for multi-router isolation. Uses the single
      // shared buildPerRouterTrie so the production serialized trie is built by
      // exactly the same code as the dev/HMR runtime rebuild (manifest-init.ts).
      // Returns null for route-less manifests (route-trie.ts).
      for (const { id, manifest } of allManifests) {
        const perRouterTrie = buildPerRouterTrie(manifest);
        if (perRouterTrie) {
          newPerRouterTrieMap.set(id, perRouterTrie);
        }
      }
    }
  }

  debug?.(
    "inner: trie build done (%sms)",
    (performance.now() - trieStart).toFixed(1),
  );

  // Commit all local state to the shared discovery state atomically.
  // This ensures a failed re-discovery (e.g. from a transient module
  // evaluation error) preserves the last known-good state.
  state.mergedRouteManifest = newMergedRouteManifest;
  state.mergedPrecomputedEntries = newMergedPrecomputedEntries;
  state.perRouterManifests = newPerRouterManifests;
  state.perRouterManifestDataMap = newPerRouterManifestDataMap;
  state.perRouterPrecomputedMap = newPerRouterPrecomputedMap;
  state.perRouterTrieMap = newPerRouterTrieMap;
  state.mergedRouteTrie = newMergedRouteTrie;

  // Expand prerender routes and render static handlers (build mode only)
  await expandPrerenderRoutes(state, rscEnv, registry, allManifests);
  await renderStaticHandlers(state, rscEnv, registry);

  return serverMod;
}
