/**
 * Router Discovery
 *
 * Core discovery logic: imports the user's entry file via the RSC
 * environment's module runner, generates manifests for each discovered
 * router, and builds route tries for O(path_length) matching.
 */

import { buildCombinedRouteMapForRouterFile } from "../../build/generate-route-types.js";
import {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
} from "../utils/manifest-utils.js";
import type { DiscoveryState, PrecomputedEntry } from "./state.js";
import {
  expandPrerenderRoutes,
  renderStaticHandlers,
} from "./prerender-collection.js";

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
  await rscEnv.runner.import(state.resolvedEntryPath);

  // Import the router package to access the registry
  const serverMod = await rscEnv.runner.import("@rangojs/router/server");
  let registry: Map<string, any> = serverMod.RouterRegistry;

  if (!registry || registry.size === 0) {
    // No RSC routers found directly. Check for host routers with lazy handlers
    // that need to be resolved to trigger sub-app createRouter() calls.
    try {
      const hostMod = await rscEnv.runner.import("@rangojs/router/host");
      const hostRegistry: Map<string, any> | undefined =
        hostMod.HostRouterRegistry;

      if (hostRegistry && hostRegistry.size > 0) {
        console.log(
          `[rsc-router] Found ${hostRegistry.size} host router(s), resolving lazy handlers...`,
        );

        for (const [, entry] of hostRegistry) {
          for (const route of entry.routes) {
            if (typeof route.handler === "function") {
              try {
                await route.handler();
              } catch {
                // Lazy handler may fail in temp server context, that's OK
              }
            }
          }
          if (entry.fallback && typeof entry.fallback.handler === "function") {
            try {
              await entry.fallback.handler();
            } catch {
              // Fallback handler may fail in temp server context
            }
          }
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
    } catch {
      // @rangojs/router/host not available or import failed, skip
    }

    // If still no routers after host router resolution, fail
    if (!registry || registry.size === 0) {
      throw new Error(
        `[rsc-router] No routers found in registry after importing ${state.resolvedEntryPath}`,
      );
    }
  }

  // Import build utilities for manifest generation
  const buildMod = await rscEnv.runner.import("@rangojs/router/build");
  const generateManifest = buildMod.generateManifest;

  state.mergedRouteManifest = {};
  state.mergedPrecomputedEntries = [];
  state.perRouterManifests = [];
  state.perRouterManifestDataMap = new Map();
  state.perRouterPrecomputedMap = new Map();
  state.perRouterTrieMap = new Map();
  let mergedRouteAncestry: Record<string, string[]> = {};
  let mergedRouteTrailingSlash: Record<string, string> = {};

  let routerMountIndex = 0;
  // Collect all manifests for trie building (avoid re-running generateManifest)
  const allManifests: Array<{ id: string; manifest: any }> = [];

  for (const [id, router] of registry) {
    if (!router.urlpatterns || !generateManifest) {
      continue;
    }

    const manifest = generateManifest(router.urlpatterns, routerMountIndex);
    routerMountIndex++;
    allManifests.push({ id, manifest });
    const routeCount = Object.keys(manifest.routeManifest).length;
    const staticRoutes = Object.values(manifest.routeManifest).filter(
      (p: any) => !p.includes(":") && !p.includes("*"),
    ).length;
    const dynamicRoutes = routeCount - staticRoutes;

    // Merge into the combined manifest
    Object.assign(state.mergedRouteManifest, manifest.routeManifest);

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

    state.perRouterManifests.push({
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
    flattenLeafEntries(
      manifest.prefixTree,
      manifest.routeManifest,
      state.mergedPrecomputedEntries,
    );

    // Store per-router manifest and precomputed entries for isolated virtual modules.
    state.perRouterManifestDataMap.set(id, manifest.routeManifest);
    const routerPrecomputed: PrecomputedEntry[] = [];
    flattenLeafEntries(
      manifest.prefixTree,
      manifest.routeManifest,
      routerPrecomputed,
    );
    state.perRouterPrecomputedMap.set(id, routerPrecomputed);

    console.log(
      `[rsc-router] Router "${id}" -> ${routeCount} routes ` +
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
        `[rsc-router] WARNING: ${autoIds.length} routers use auto-generated IDs (${autoIds.join(", ")}). ` +
          `In multi-router setups, each createRouter() must have an explicit \`id\` option ` +
          `to ensure per-router manifest data is matched correctly at runtime. ` +
          `Example: createRouter({ id: "site", ... })`,
      );
    }
  }

  // Build route trie from merged manifest + ancestry
  if (
    state.mergedRouteManifest &&
    Object.keys(state.mergedRouteManifest).length > 0
  ) {
    const buildRouteTrie = buildMod.buildRouteTrie;
    if (buildRouteTrie && mergedRouteAncestry) {
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

      state.mergedRouteTrie = buildRouteTrie(
        state.mergedRouteManifest,
        mergedRouteAncestry,
        routeToStaticPrefix,
        Object.keys(mergedRouteTrailingSlash).length > 0
          ? mergedRouteTrailingSlash
          : undefined,
        prerenderRouteNames.size > 0 ? prerenderRouteNames : undefined,
        passthroughRouteNames.size > 0 ? passthroughRouteNames : undefined,
        Object.keys(mergedResponseTypeRoutes).length > 0
          ? mergedResponseTypeRoutes
          : undefined,
      );

      // Build per-router tries for multi-router isolation.
      for (const { id, manifest } of allManifests) {
        if (
          !manifest._routeAncestry ||
          Object.keys(manifest._routeAncestry).length === 0
        )
          continue;
        const perRouterStaticPrefix: Record<string, string> = {};
        for (const name of Object.keys(manifest.routeManifest)) {
          perRouterStaticPrefix[name] = "";
        }
        buildRouteToStaticPrefix(manifest.prefixTree, perRouterStaticPrefix);

        const perRouterPrerenderNames = manifest.prerenderRoutes
          ? new Set<string>(manifest.prerenderRoutes)
          : undefined;
        const perRouterPassthroughNames = manifest.passthroughRoutes
          ? new Set<string>(manifest.passthroughRoutes)
          : undefined;

        const perRouterTrie = buildRouteTrie(
          manifest.routeManifest,
          manifest._routeAncestry,
          perRouterStaticPrefix,
          manifest.routeTrailingSlash &&
            Object.keys(manifest.routeTrailingSlash).length > 0
            ? manifest.routeTrailingSlash
            : undefined,
          perRouterPrerenderNames && perRouterPrerenderNames.size > 0
            ? perRouterPrerenderNames
            : undefined,
          perRouterPassthroughNames && perRouterPassthroughNames.size > 0
            ? perRouterPassthroughNames
            : undefined,
          manifest.responseTypeRoutes &&
            Object.keys(manifest.responseTypeRoutes).length > 0
            ? manifest.responseTypeRoutes
            : undefined,
        );
        state.perRouterTrieMap.set(id, perRouterTrie);
      }
    }
  }

  // Expand prerender routes and render static handlers (build mode only)
  await expandPrerenderRoutes(state, rscEnv, registry, allManifests);
  await renderStaticHandlers(state, rscEnv, registry);

  return serverMod;
}
