import type { Plugin } from "vite";
import { createServer as createViteServer } from "vite";
import { resolve, join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import {
  generateRouteTypesSource,
  writeCombinedRouteTypes,
  findRouterFiles,
  createScanFilter,
  buildCombinedRouteMapForRouterFile,
  type ScanFilter,
} from "../build/generate-route-types.ts";
import { VIRTUAL_IDS } from "./plugins/virtual-entries.ts";
import { contextSet } from "../context-var.js";
import { createVersionPlugin } from "./plugins/version-plugin.ts";
import { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.ts";
import {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.ts";
import { hashClientRefs } from "./plugins/client-ref-hashing.ts";
import {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
  jsonParseExpression,
} from "./utils/manifest-utils.ts";
import {
  encodePathParam,
  runWithConcurrency,
  groupByConcurrency,
  notifyOnError,
} from "./utils/prerender-utils.ts";
import {
  extractHandlerExportsFromChunk,
  evictHandlerCode,
} from "./utils/bundle-analysis.ts";

export const VIRTUAL_ROUTES_MANIFEST_ID = "virtual:rsc-router/routes-manifest";
// VIRTUAL_PRERENDER_PATHS_ID removed: prerender data is served through the worker

/**
 * Plugin that discovers router instances at dev/build time via the RSC environment.
 *
 * Uses `server.environments.rsc.runner.import()` to load the user's router file
 * with full TS/TSX compilation. This triggers `createRouter()` which populates
 * the `RouterRegistry`. The plugin then generates manifests for each router.
 *
 * In dev mode, this runs in `configureServer` (post-middleware setup).
 * In build mode, this will run in `buildStart` (future).
 *
 * @internal
 */
export function createRouterDiscoveryPlugin(
  entryPath: string | undefined,
  opts?: {
    enableBuildPrerender?: boolean;
    staticRouteTypesGeneration?: boolean;
    include?: string[];
    exclude?: string[];
  },
): Plugin {
  let resolvedEntryPath: string | undefined = entryPath;
  let projectRoot = "";
  let isBuildMode = false;
  let userResolveAlias: any = undefined;

  // Scan filter compiled from include/exclude patterns (created in configResolved)
  let scanFilter: ScanFilter | undefined;

  // Cached router file paths (files containing createRouter) from initial scan.
  // Reused by the file watcher to avoid re-scanning the entire directory tree.
  let cachedRouterFiles: string[] | undefined;

  // Merged route manifest from all discovered routers.
  // Populated during discovery (dev: configureServer, build: buildStart).
  // Read by the virtual module's load hook to emit setCachedManifest() call.
  let mergedRouteManifest: Record<string, string> | null = null;

  // Per-router route manifests for generating typed route files.
  let perRouterManifests: Array<{
    id: string;
    routeManifest: Record<string, string>;
    routeSearchSchemas?: Record<string, Record<string, string>>;
    sourceFile?: string;
    factoryOnlyPrefixes?: Set<string>;
  }> = [];

  // Collected prerender data from in-process collection during discoverRouters().
  // Consumed by closeBundle to inject into the RSC entry bundle.
  let prerenderCollectedData: Record<string, any> | null = null;

  // Handler chunk metadata recorded during generateBundle for post-build eviction.
  let handlerChunkInfo: {
    fileName: string;
    exports: Array<{ name: string; handlerId: string; passthrough: boolean }>;
  } | null = null;

  // RSC entry chunk filename recorded during generateBundle for closeBundle injection.
  let rscEntryFileName: string | null = null;

  // Collected static handler data: handlerId -> { encoded Flight payload, handle data }.
  let staticCollectedData: Record<
    string,
    { encoded: string; handles: Record<string, unknown[]> }
  > | null = null;

  // Handler chunk info for __static-handlers, populated by generateBundle.
  let staticHandlerChunkInfo: {
    fileName: string;
    exports: Array<{ name: string; handlerId: string; passthrough: boolean }>;
  } | null = null;

  // Resolved prerender handler modules from the expose-internal-ids plugin.
  let resolvedPrerenderModules: Map<string, string[]> | undefined;

  // Resolved static handler modules from the expose-internal-ids plugin.
  let resolvedStaticModules: Map<string, string[]> | undefined;

  // Promise that resolves when dev-mode discovery completes.
  // The virtual module's load hook awaits this to ensure data is available.
  let discoveryDone: Promise<void> | null = null;

  // Pre-computed route entries from prefix tree leaf nodes.
  // Leaf nodes have no nested includes, so their routes can be used directly
  // by evaluateLazyEntry() without running the handler.
  let mergedPrecomputedEntries: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> | null = null;

  // Route trie for O(path_length) matching at runtime.
  let mergedRouteTrie: any = null;

  // Per-router isolated data for multi-router manifest splitting.
  // Each router gets its own manifest, trie, and precomputed entries so that
  // virtual:rsc-router/routes-manifest/<routerId> modules can be emitted.
  let perRouterTrieMap: Map<string, any> = new Map();
  let perRouterPrecomputedMap: Map<
    string,
    Array<{ staticPrefix: string; routes: Record<string, string> }>
  > = new Map();
  let perRouterManifestDataMap: Map<string, Record<string, string>> = new Map();

  // Dev-mode state for on-demand prerender endpoint.
  let devServerOrigin: string | null = null;
  let devServer: any = null;
  // Tracks gen files recently written by this plugin so the watcher can
  // distinguish self-triggered change events from manual edits.
  const selfWrittenGenFiles = new Map<string, { at: number; hash: string }>();
  const SELF_WRITE_WINDOW_MS = 5_000;

  function markSelfGenWrite(filePath: string, content: string): void {
    const hash = createHash("sha256").update(content).digest("hex");
    selfWrittenGenFiles.set(filePath, { at: Date.now(), hash });
  }

  function consumeSelfGenWrite(filePath: string): boolean {
    const info = selfWrittenGenFiles.get(filePath);
    if (!info) return false;
    if (Date.now() - info.at > SELF_WRITE_WINDOW_MS) {
      selfWrittenGenFiles.delete(filePath);
      return false;
    }
    try {
      const current = readFileSync(filePath, "utf-8");
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (currentHash === info.hash) {
        selfWrittenGenFiles.delete(filePath);
        return true;
      }
      // Hash mismatch: file was changed externally. Keep the entry so a
      // subsequent watcher event from our own write can still be consumed
      // (e.g. when multiple Vite servers watch the same directory).
      return false;
    } catch {
      selfWrittenGenFiles.delete(filePath);
      return false;
    }
  }

  // Shared discovery logic: import entry via RSC runner, generate manifests,
  // write static files, and populate mergedRouteManifest.
  async function discoverRouters(rscEnv: any) {
    if (!resolvedEntryPath) return;
    // Import the entry file via RSC environment.
    // For node preset: this is the router file (createRouter() registers in RouterRegistry).
    // For cloudflare preset: this is the worker entry (which imports the router).
    await rscEnv.runner.import(resolvedEntryPath);

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
            if (
              entry.fallback &&
              typeof entry.fallback.handler === "function"
            ) {
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
          `[rsc-router] No routers found in registry after importing ${resolvedEntryPath}`,
        );
      }
    }

    // Import build utilities for manifest generation
    const buildMod = await rscEnv.runner.import("@rangojs/router/build");
    const generateManifest = buildMod.generateManifest;

    mergedRouteManifest = {};
    mergedPrecomputedEntries = [];
    perRouterManifests = [];
    perRouterManifestDataMap = new Map();
    perRouterPrecomputedMap = new Map();
    perRouterTrieMap = new Map();
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
      Object.assign(mergedRouteManifest, manifest.routeManifest);
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

      perRouterManifests.push({
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
        mergedPrecomputedEntries,
      );

      // Store per-router manifest and precomputed entries for isolated virtual modules.
      perRouterManifestDataMap.set(id, manifest.routeManifest);
      const routerPrecomputed: Array<{
        staticPrefix: string;
        routes: Record<string, string>;
      }> = [];
      flattenLeafEntries(
        manifest.prefixTree,
        manifest.routeManifest,
        routerPrecomputed,
      );
      perRouterPrecomputedMap.set(id, routerPrecomputed);

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
    if (mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0) {
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
            Object.assign(
              mergedResponseTypeRoutes,
              manifest.responseTypeRoutes,
            );
          }
        }

        mergedRouteTrie = buildRouteTrie(
          mergedRouteManifest,
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
          perRouterTrieMap.set(id, perRouterTrie);
        }
      }
    }

    // Expand prerender routes into concrete URLs for build-time rendering.
    // Static routes use pattern as-is; dynamic routes call getParams() to enumerate.
    // Each entry tracks its route name and concurrency setting for grouped parallel rendering.
    if (opts?.enableBuildPrerender && isBuildMode) {
      type PrerenderEntry = {
        urlPath: string;
        routeName: string;
        concurrency: number;
        buildVars?: Record<string, any>;
      };
      const entries: PrerenderEntry[] = [];

      // Build a merged route map for getParams context reverse()
      const allRoutes: Record<string, string> = {};
      for (const { manifest: m } of allManifests) {
        if (m.routeManifest) Object.assign(allRoutes, m.routeManifest);
      }
      const getParamsReverse = (
        name: string,
        params?: Record<string, string>,
      ) => {
        const pattern = allRoutes[name];
        if (!pattern) throw new Error(`Unknown route: "${name}"`);
        let result = pattern;
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            // Strip constraint syntax: :param(a|b) -> value
            result = result.replace(
              new RegExp(`:${key}(\\([^)]*\\))?`),
              encodeURIComponent(value),
            );
            result = result.replace(`*${key}`, encodeURIComponent(value));
          }
        }
        return result;
      };

      for (const { manifest } of allManifests) {
        if (!manifest.prerenderRoutes) continue;
        const defs = manifest._prerenderDefs || {};
        for (const routeName of manifest.prerenderRoutes) {
          const pattern = manifest.routeManifest[routeName];
          if (!pattern) continue;
          const hasDynamic = pattern.includes(":") || pattern.includes("*");
          if (!hasDynamic) {
            // Static route: use pattern directly (strip trailing slash for URL)
            entries.push({
              urlPath: pattern.replace(/\/$/, "") || "/",
              routeName,
              concurrency: 1,
            });
          } else {
            // Dynamic route: call getParams() to enumerate param combinations
            const def = defs[routeName];
            if (def?.getParams) {
              try {
                const buildVars: Record<string, any> = {};
                const getParamsCtx = {
                  build: true as const,
                  set: ((keyOrVar: any, value: any) => {
                    contextSet(buildVars, keyOrVar, value);
                  }) as any,
                  reverse: getParamsReverse,
                };
                const paramsList = await def.getParams(getParamsCtx);
                const concurrency = def.options?.concurrency ?? 1;
                const hasBuildVars =
                  Object.keys(buildVars).length > 0 ||
                  Object.getOwnPropertySymbols(buildVars).length > 0;
                for (const params of paramsList) {
                  let url = pattern;
                  for (const [key, value] of Object.entries(
                    params as Record<string, string>,
                  )) {
                    const encoded = encodePathParam(value);
                    // Strip constraint syntax: :param(a|b) -> value
                    url = url.replace(
                      new RegExp(`:${key}(\\([^)]*\\))?`),
                      encoded,
                    );
                    url = url.replace(`*${key}`, encoded);
                  }
                  // Anonymous wildcard fallback: use conventional keys if provided
                  if (url.includes("*")) {
                    const wildcardValue =
                      (params as Record<string, string>)["*"] ??
                      (params as Record<string, string>).splat;
                    if (wildcardValue !== undefined) {
                      url = url.replace(
                        /\*[^/]*$/,
                        encodePathParam(wildcardValue),
                      );
                    }
                  }
                  entries.push({
                    urlPath: url.replace(/\/$/, "") || "/",
                    routeName,
                    concurrency,
                    ...(hasBuildVars ? { buildVars } : {}),
                  });
                }
              } catch (err: any) {
                // Skip in getParams() skips the entire route
                if (err.name === "Skip") {
                  console.log(
                    `[rsc-router]   SKIP route "${routeName}" - ${err.message}`,
                  );
                  notifyOnError(
                    registry,
                    err,
                    "prerender",
                    routeName,
                    undefined,
                    true,
                  );
                  continue;
                }
                // Regular error: fail the build
                console.error(
                  `[rsc-router] Failed to get params for prerender route "${routeName}": ${err.message}`,
                );
                notifyOnError(registry, err, "prerender", routeName);
                throw err;
              }
            } else {
              console.warn(
                `[rsc-router] Dynamic prerender route "${routeName}" has no getParams(), skipping`,
              );
            }
          }
        }
      }
      if (entries.length > 0) {
        // Determine the max concurrency for the log header
        const maxConcurrency = Math.max(...entries.map((e) => e.concurrency));
        const concurrencyNote =
          maxConcurrency > 1 ? ` (concurrency: ${maxConcurrency})` : "";
        console.log(
          `[rsc-router] Pre-rendering ${entries.length} URL(s)${concurrencyNote}...`,
        );

        const { hashParams } = await rscEnv.runner.import(
          "@rangojs/router/build",
        );

        const collectedData: Record<string, any> = {};
        let doneCount = 0;
        let skipCount = 0;
        const startTotal = performance.now();

        // Group entries by concurrency for batched rendering.
        // Within each group, all entries share the same concurrency limit.
        const groups = groupByConcurrency(entries);

        for (const group of groups) {
          await runWithConcurrency(
            group.entries,
            group.concurrency,
            async (entry) => {
              const startUrl = performance.now();
              for (const [, routerInstance] of registry) {
                if (!routerInstance.matchForPrerender) continue;
                try {
                  const result = await routerInstance.matchForPrerender(
                    entry.urlPath,
                    {},
                    entry.buildVars,
                  );
                  if (!result) continue;
                  const paramHash = hashParams(result.params || {});
                  collectedData[`${result.routeName}/${paramHash}`] = {
                    segments: result.segments,
                    handles: result.handles,
                  };
                  if (result.interceptSegments?.length) {
                    collectedData[`${result.routeName}/${paramHash}/i`] = {
                      segments: [
                        ...result.segments,
                        ...result.interceptSegments,
                      ],
                      handles: {
                        ...result.handles,
                        ...(result.interceptHandles || {}),
                      },
                    };
                  }
                  const elapsed = (performance.now() - startUrl).toFixed(0);
                  console.log(
                    `[rsc-router]   OK   ${entry.urlPath.padEnd(40)} (${elapsed}ms)`,
                  );
                  doneCount++;
                  break;
                } catch (err: any) {
                  if (err.name === "Skip") {
                    const elapsed = (performance.now() - startUrl).toFixed(0);
                    console.log(
                      `[rsc-router]   SKIP ${entry.urlPath.padEnd(40)} (${elapsed}ms) - ${err.message}`,
                    );
                    skipCount++;
                    notifyOnError(
                      registry,
                      err,
                      "prerender",
                      entry.routeName,
                      entry.urlPath,
                      true,
                    );
                    break;
                  }
                  // Regular error: log, notify, and fail the build
                  const elapsed = (performance.now() - startUrl).toFixed(0);
                  console.error(
                    `[rsc-router]   FAIL ${entry.urlPath.padEnd(40)} (${elapsed}ms) - ${err.message}`,
                  );
                  notifyOnError(
                    registry,
                    err,
                    "prerender",
                    entry.routeName,
                    entry.urlPath,
                  );
                  throw err;
                }
              }
            },
          );
        }

        const totalElapsed = (performance.now() - startTotal).toFixed(0);
        if (doneCount > 0) {
          prerenderCollectedData = collectedData;
        }
        const parts = [`${doneCount} done`];
        if (skipCount > 0) parts.push(`${skipCount} skipped`);
        console.log(
          `[rsc-router] Pre-render complete: ${parts.join(", ")} (${totalElapsed}ms total)`,
        );
      }
    }

    // Render Static handlers at build time (segment-level, not route-level).
    // Each Static handler is called with a synthetic BuildContext and its
    // output is RSC-serialized. The encoded string is stored keyed by handler $$id.
    if (
      opts?.enableBuildPrerender &&
      isBuildMode &&
      resolvedStaticModules?.size
    ) {
      const collected: Record<
        string,
        { encoded: string; handles: Record<string, unknown[]> }
      > = {};
      let staticDone = 0;
      let staticSkip = 0;
      let totalStaticCount = 0;

      // Count handlers for the log header
      for (const [, exportNames] of resolvedStaticModules) {
        totalStaticCount += exportNames.length;
      }
      const startStatic = performance.now();
      console.log(
        `[rsc-router] Rendering ${totalStaticCount} static handler(s)...`,
      );

      for (const [moduleId, exportNames] of resolvedStaticModules) {
        let mod: any;
        try {
          mod = await rscEnv!.runner.import(moduleId);
        } catch (err: any) {
          console.error(
            `[rsc-router] Failed to import static module ${moduleId}: ${err.message}`,
          );
          notifyOnError(registry, err, "static");
          throw err;
        }

        for (const name of exportNames) {
          const def = mod[name];
          if (!def || def.__brand !== "staticHandler" || !def.$$id) continue;
          // Passthrough handlers stay live in the bundle
          if (def.options?.passthrough) continue;

          const startHandler = performance.now();
          let handled = false;
          for (const [, routerInstance] of registry) {
            if (!routerInstance.renderStaticSegment) continue;
            try {
              const result = await routerInstance.renderStaticSegment(
                def.handler,
                def.$$id,
                (def as any).$$routePrefix,
              );
              if (result) {
                collected[def.$$id] = result;
                const elapsed = (performance.now() - startHandler).toFixed(0);
                console.log(
                  `[rsc-router]   OK   ${name.padEnd(40)} (${elapsed}ms)`,
                );
                staticDone++;
                handled = true;
                break;
              }
            } catch (err: any) {
              if (err.name === "Skip") {
                const elapsed = (performance.now() - startHandler).toFixed(0);
                console.log(
                  `[rsc-router]   SKIP ${name.padEnd(40)} (${elapsed}ms) - ${err.message}`,
                );
                staticSkip++;
                notifyOnError(
                  registry,
                  err,
                  "static",
                  undefined,
                  undefined,
                  true,
                );
                handled = true;
                break;
              }
              // Regular error: log, notify, and fail the build
              const elapsed = (performance.now() - startHandler).toFixed(0);
              console.error(
                `[rsc-router]   FAIL ${name.padEnd(40)} (${elapsed}ms) - ${err.message}`,
              );
              notifyOnError(registry, err, "static");
              throw err;
            }
          }
          if (!handled) {
            console.warn(
              `[rsc-router] No router could render static handler "${name}"`,
            );
          }
        }
      }

      const totalStaticElapsed = (performance.now() - startStatic).toFixed(0);
      if (staticDone > 0) {
        staticCollectedData = collected;
      }
      const staticParts = [`${staticDone} done`];
      if (staticSkip > 0) staticParts.push(`${staticSkip} skipped`);
      console.log(
        `[rsc-router] Static render complete: ${staticParts.join(", ")} (${totalStaticElapsed}ms total)`,
      );
    }

    return serverMod;
  }

  // Write per-router named-routes type files next to each router's source file.
  // Each router gets its own {basename}.named-routes.gen.ts with only its routes.
  // Only writes when content has changed to avoid triggering HMR loops.
  function writeCombinedRouteTypesWithTracking(opts?: {
    preserveIfLarger?: boolean;
  }): void {
    const routerFiles =
      cachedRouterFiles ?? findRouterFiles(projectRoot, scanFilter);
    cachedRouterFiles = routerFiles;

    // Snapshot pre-write content to detect which files actually change.
    const preContent = new Map<string, string>();
    for (const routerFilePath of routerFiles) {
      const routerDir = dirname(routerFilePath);
      const routerBasename = basename(routerFilePath).replace(
        /\.(tsx?|jsx?)$/,
        "",
      );
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      try {
        preContent.set(outPath, readFileSync(outPath, "utf-8"));
      } catch {
        // File doesn't exist yet — any write is a real change.
      }
    }

    writeCombinedRouteTypes(projectRoot, routerFiles, opts);

    // Mark only files that were actually written so the watcher can
    // distinguish self-triggered change events from manual edits.
    // Marking unchanged files creates stale entries that interfere with
    // multi-server setups (e.g. shared webServer + isolated HMR server).
    for (const routerFilePath of routerFiles) {
      const routerDir = dirname(routerFilePath);
      const routerBasename = basename(routerFilePath).replace(
        /\.(tsx?|jsx?)$/,
        "",
      );
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      if (!existsSync(outPath)) continue;
      try {
        const content = readFileSync(outPath, "utf-8");
        if (content !== preContent.get(outPath)) {
          markSelfGenWrite(outPath, content);
        }
      } catch {
        // Ignore transient fs errors while files are being rewritten.
      }
    }
  }

  function writeRouteTypesFiles() {
    if (perRouterManifests.length === 0) return;

    // Delete old combined named-routes.gen.ts if it exists
    try {
      const entryDir = dirname(resolve(projectRoot, resolvedEntryPath!));
      const oldCombinedPath = join(entryDir, "named-routes.gen.ts");
      if (existsSync(oldCombinedPath)) {
        unlinkSync(oldCombinedPath);
        console.log(
          `[rsc-router] Removed stale combined route types: ${oldCombinedPath}`,
        );
      }
    } catch {}

    for (const {
      id,
      routeManifest,
      routeSearchSchemas,
      sourceFile,
    } of perRouterManifests) {
      if (!sourceFile) continue;

      // Validate sourceFile points to a real project file, not node_modules or
      // a Vite internal path. A bad sourceFile leads to route types written to
      // the wrong location, causing non-deterministic type resolution.
      if (sourceFile.includes("node_modules")) {
        throw new Error(
          `[rsc-router] Router "${id}" has sourceFile inside node_modules: ${sourceFile}\n` +
            `This means createRouter() stack trace parsing matched a Vite internal frame.\n` +
            `Set an explicit \`id\` on createRouter() or check the call site.`,
        );
      }

      const routerDir = dirname(sourceFile);
      const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      let effectiveSearchSchemas = routeSearchSchemas;

      // Runtime manifest may omit search schema metadata in some module-runner
      // flows. Fall back to static source parsing from the router file.
      if (
        (!effectiveSearchSchemas ||
          Object.keys(effectiveSearchSchemas).length === 0) &&
        sourceFile
      ) {
        const staticParsed = buildCombinedRouteMapForRouterFile(sourceFile);
        if (Object.keys(staticParsed.searchSchemas).length > 0) {
          const filtered: Record<string, Record<string, string>> = {};
          for (const name of Object.keys(routeManifest)) {
            const schema = staticParsed.searchSchemas[name];
            if (schema) filtered[name] = schema;
          }
          if (Object.keys(filtered).length > 0) {
            effectiveSearchSchemas = filtered;
          }
        }
      }

      const source = generateRouteTypesSource(
        routeManifest,
        effectiveSearchSchemas && Object.keys(effectiveSearchSchemas).length > 0
          ? effectiveSearchSchemas
          : undefined,
      );
      const existing = existsSync(outPath)
        ? readFileSync(outPath, "utf-8")
        : null;
      if (existing !== source) {
        markSelfGenWrite(outPath, source);
        writeFileSync(outPath, source);
        console.log(`[rsc-router] Generated route types -> ${outPath}`);
      }
    }
  }

  // After the static parser writes a gen file, supplement it with route groups
  // from the runtime manifests that the static parser can't resolve (factory
  // calls like createDocsPatterns()). Only adds groups whose dot-prefix (e.g.
  // "docs.") is entirely absent from the static output. Groups partially
  // visible to the static parser are left alone so renames/removals propagate
  // immediately without requiring a server restart.
  //
  // The runtime manifest (cachedManifest / perRouterManifestMap) is updated
  // automatically: the virtual:rsc-router/routes-manifest module imports the
  // gen file, so when we write new content here, Vite's HMR invalidates the
  // virtual module and re-evaluates it on the next request.
  function supplementGenFilesWithRuntimeRoutes() {
    // Cache static parsing results to avoid redundant I/O + parsing per router.
    const parseCache = new Map<
      string,
      ReturnType<typeof buildCombinedRouteMapForRouterFile>
    >();
    const getParsed = (file: string) => {
      let cached = parseCache.get(file);
      if (!cached) {
        cached = buildCombinedRouteMapForRouterFile(file);
        parseCache.set(file, cached);
      }
      return cached;
    };

    for (const {
      routeManifest,
      routeSearchSchemas,
      sourceFile,
      factoryOnlyPrefixes,
    } of perRouterManifests) {
      if (!sourceFile) continue;
      if (!factoryOnlyPrefixes || factoryOnlyPrefixes.size === 0) continue;

      const staticParsed = getParsed(sourceFile);

      // Merge: static routes (authoritative) + factory-only groups from runtime.
      const mergedRoutes: Record<string, string> = { ...staticParsed.routes };
      const mergedSearchSchemas: Record<string, Record<string, string>> = {
        ...staticParsed.searchSchemas,
      };

      for (const [name, pattern] of Object.entries(routeManifest)) {
        const dotIdx = name.indexOf(".");
        if (dotIdx <= 0) continue;
        const prefix = name.substring(0, dotIdx + 1);
        if (factoryOnlyPrefixes.has(prefix)) {
          mergedRoutes[name] = pattern;
          // Also merge search schemas from factory-generated routes
          if (routeSearchSchemas?.[name]) {
            mergedSearchSchemas[name] = routeSearchSchemas[name];
          }
        }
      }

      const routerDir = dirname(sourceFile);
      const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      const source = generateRouteTypesSource(
        mergedRoutes,
        Object.keys(mergedSearchSchemas).length > 0
          ? mergedSearchSchemas
          : undefined,
      );
      const existing = existsSync(outPath)
        ? readFileSync(outPath, "utf-8")
        : null;
      if (existing !== source) {
        markSelfGenWrite(outPath, source);
        writeFileSync(outPath, source);
      }
    }
    // No manual manifest update needed: the virtual module imports the gen
    // file, so Vite's HMR automatically re-evaluates it with fresh data.
  }

  return {
    name: "@rangojs/router:discovery",

    config() {
      const config: any = {
        define: {
          __RANGO_DEBUG__: JSON.stringify(!!process.env.INTERNAL_RANGO_DEBUG),
        },
      };
      if (opts?.enableBuildPrerender) {
        config.environments = {
          rsc: {
            build: {
              rollupOptions: {
                output: {
                  manualChunks(id: string) {
                    if (resolvedPrerenderModules?.has(id)) {
                      return "__prerender-handlers";
                    }
                    if (resolvedStaticModules?.has(id)) {
                      return "__static-handlers";
                    }
                  },
                },
              },
            },
          },
        };
      }
      return config;
    },

    configResolved(config) {
      projectRoot = config.root;
      isBuildMode = config.command === "build";
      // Capture user's resolve aliases for the temp server
      userResolveAlias = config.resolve.alias;
      // Cloudflare preset: read entry from resolved environment config.
      // The @cloudflare/vite-plugin reads wrangler config (toml/json/jsonc)
      // and sets optimizeDeps.entries on the RSC environment.
      if (!resolvedEntryPath) {
        const rscEnvConfig = (config.environments as any)?.["rsc"];
        const entries = rscEnvConfig?.optimizeDeps?.entries;
        if (typeof entries === "string") {
          resolvedEntryPath = entries;
        } else if (Array.isArray(entries) && entries.length > 0) {
          resolvedEntryPath = entries[0];
        }
      }
      // Compile include/exclude patterns into a scan filter
      if (opts?.include || opts?.exclude) {
        scanFilter = createScanFilter(projectRoot, {
          include: opts.include,
          exclude: opts.exclude,
        });
      }
      // Generate combined named-routes.gen.ts from static source parsing.
      // Runs before the dev server starts so the gen file exists immediately for IDE.
      // In build mode, the runtime discovery in buildStart produces the definitive
      // named-routes.gen.ts (including dynamically generated routes).
      // preserveIfLarger prevents overwriting a previously generated complete
      // file with a partial one.
      if (opts?.staticRouteTypesGeneration !== false) {
        cachedRouterFiles = findRouterFiles(projectRoot, scanFilter);
        writeCombinedRouteTypesWithTracking({ preserveIfLarger: true });
      }
      // Resolve prerenderHandlerModules and staticHandlerModules from the consolidated IDs plugin's API.
      if (opts?.enableBuildPrerender) {
        const idsPlugin = config.plugins.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        resolvedPrerenderModules = (idsPlugin?.api as any)
          ?.prerenderHandlerModules;
        resolvedStaticModules = (idsPlugin?.api as any)?.staticHandlerModules;
      }
    },

    // Dev mode: discover routers and populate manifest in memory.
    // Skipped in build mode (buildStart handles it).
    configureServer(server) {
      if (isBuildMode) return;
      // Skip if this is a temp server created by buildStart
      if ((globalThis as any).__rscRouterDiscoveryActive) return;
      devServer = server;

      // Discovery promise that the handler can await if requests arrive
      // before discovery completes
      let resolveDiscovery: () => void;
      const discoveryPromise = new Promise<void>((resolve) => {
        resolveDiscovery = resolve;
      });

      // Compute dev server origin from resolved URLs (preferred) or config port (fallback).
      // Called after discovery (or in the load hook) when the server may be listening.
      const getDevServerOrigin = () =>
        server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ||
        `http://localhost:${server.config.server.port || 5173}`;

      // Shared temp server for Cloudflare dev (no module runner in workerd).
      // Used by both discover() (route type generation) and the prerender
      // middleware (on-demand prerender evaluation). Created lazily, closed on
      // server shutdown.
      let prerenderTempServer: any = null;
      let prerenderNodeRegistry: Map<string, any> | null = null;

      // Clean up the temporary server when the dev server shuts down
      server.httpServer?.on("close", () => {
        if (prerenderTempServer) {
          prerenderTempServer.close().catch(() => {});
          prerenderTempServer = null;
        }
      });

      async function getOrCreateTempServer(): Promise<any | null> {
        if (prerenderNodeRegistry) {
          return (prerenderTempServer.environments as any)?.rsc ?? null;
        }
        try {
          const { default: rsc } = await import("@vitejs/plugin-rsc");
          prerenderTempServer = await createViteServer({
            root: projectRoot,
            configFile: false,
            server: { middlewareMode: true },
            appType: "custom",
            logLevel: "silent",
            cacheDir: "node_modules/.vite_prerender",
            resolve: { alias: userResolveAlias },
            esbuild: { jsx: "automatic", jsxImportSource: "react" },
            plugins: [
              rsc({
                entries: {
                  client: "virtual:entry-client",
                  ssr: "virtual:entry-ssr",
                  rsc: resolvedEntryPath!,
                },
              }),
              createVersionPlugin(),
              createVirtualStubPlugin(),
              // Dev prerender must use dev-mode IDs (path-based) to match the
              // workerd runtime. forceBuild would produce hashed IDs causing
              // handle data key mismatches when replayed into the runtime store.
              exposeInternalIds(),
              exposeRouterId(),
            ],
          });

          const tempRscEnv = (prerenderTempServer.environments as any)?.rsc;
          if (tempRscEnv?.runner) {
            await tempRscEnv.runner.import(resolvedEntryPath!);
            const serverMod = await tempRscEnv.runner.import(
              "@rangojs/router/server",
            );
            prerenderNodeRegistry = serverMod.RouterRegistry;
            return tempRscEnv;
          }
        } catch (err: any) {
          console.warn(
            `[rsc-router] Failed to create temp runner: ${err.message}`,
          );
        }
        return null;
      }

      const discover = async () => {
        const rscEnv = (server.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          // Cloudflare dev: no module runner available (workerd-based RSC env).
          // Set devServerOrigin so the virtual module can inject __PRERENDER_DEV_URL
          // for on-demand prerender via the /__rsc_prerender endpoint.
          devServerOrigin = getDevServerOrigin();

          // Create a temp Node.js server to run runtime discovery and generate
          // named route types (static parser can't resolve factory calls).
          try {
            const tempRscEnv = await getOrCreateTempServer();
            if (tempRscEnv) {
              await discoverRouters(tempRscEnv);
              writeRouteTypesFiles();
            }
          } catch (err: any) {
            console.warn(
              `[rsc-router] Cloudflare dev discovery failed: ${err.message}\n${err.stack}`,
            );
          }

          resolveDiscovery!();
          return;
        }

        try {
          // Set the readiness gate BEFORE discovery so early requests
          // block until manifest is populated
          const serverMod = await rscEnv.runner.import(
            "@rangojs/router/server",
          );
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          const serverModAfterDiscovery = await discoverRouters(rscEnv);

          // Save registry for the /__rsc_prerender endpoint (avoids creating a temp server)
          mainRegistry = serverModAfterDiscovery?.RouterRegistry ?? null;

          // Store server origin for dev prerender endpoint (virtual module injection)
          devServerOrigin = getDevServerOrigin();

          // Update named-routes.gen.ts from runtime discovery.
          // The runtime manifest is the source of truth: it evaluates dynamic
          // routes (e.g. Array.from loops) that the static parser cannot see.
          // writeRouteTypesFiles() only writes when content changes, so this
          // won't cause unnecessary HMR triggers.
          writeRouteTypesFiles();

          // Populate the route map in the RSC env
          if (mergedRouteManifest && serverMod?.setCachedManifest) {
            serverMod.setCachedManifest(mergedRouteManifest);
          }
          if (
            mergedPrecomputedEntries &&
            mergedPrecomputedEntries.length > 0 &&
            serverMod?.setPrecomputedEntries
          ) {
            serverMod.setPrecomputedEntries(mergedPrecomputedEntries);
          }
          if (mergedRouteTrie && serverMod?.setRouteTrie) {
            serverMod.setRouteTrie(mergedRouteTrie);
          }
          // Populate per-router isolated data eagerly in dev (HMR).
          // In production builds, per-router data is loaded lazily via import().
          if (serverMod?.setRouterManifest) {
            for (const [routerId, manifest] of perRouterManifestDataMap) {
              serverMod.setRouterManifest(routerId, manifest);
            }
          }
          if (serverMod?.setRouterTrie) {
            for (const [routerId, trie] of perRouterTrieMap) {
              serverMod.setRouterTrie(routerId, trie);
            }
          }
          if (serverMod?.setRouterPrecomputedEntries) {
            for (const [routerId, entries] of perRouterPrecomputedMap) {
              serverMod.setRouterPrecomputedEntries(routerId, entries);
            }
          }
        } catch (err: any) {
          console.warn(
            `[rsc-router] Router discovery failed: ${err.message}\n${err.stack}`,
          );
        } finally {
          resolveDiscovery!();
        }
      };

      // Schedule after all plugins have finished configureServer.
      // Store the promise so the virtual module's load hook can await it.
      discoveryDone = new Promise<void>((resolve) => {
        setTimeout(() => discover().then(resolve, resolve), 0);
      });

      // Dev-mode on-demand prerender endpoint.
      // When workerd hits a prerender route, it fetches this endpoint instead of
      // trying to run node:fs-dependent handlers in the Cloudflare environment.
      //
      // Node.js preset: uses the main server's RSC environment directly (router
      // instances are already discovered and have matchForPrerender).
      // Cloudflare preset: lazily creates a Node.js temp server because the main
      // RSC environment uses workerd where node:fs can't access the host filesystem.

      // Registry from the main server's RSC environment (populated by discoverRouters)
      let mainRegistry: Map<string, any> | null = null;

      server.middlewares.use("/__rsc_prerender", async (req: any, res: any) => {
        if (discoveryDone) await discoveryDone;

        const url = new URL(req.url || "/", "http://localhost");
        const pathname = url.searchParams.get("pathname");
        if (!pathname) {
          res.statusCode = 400;
          res.end("Missing pathname");
          return;
        }

        // Prefer the main server's registry (Node.js preset: module runner available).
        // Fall back to a temp server for Cloudflare where the main RSC env uses workerd.
        let registry = mainRegistry;

        if (!registry) {
          // No main registry: the RSC env has no module runner (Cloudflare dev).
          // Lazily create a Node.js temp server for prerender evaluation.
          if (!prerenderNodeRegistry) {
            await getOrCreateTempServer();
          }
          registry = prerenderNodeRegistry;
        }

        if (!registry || registry.size === 0) {
          res.statusCode = 503;
          res.end("Prerender runner not available");
          return;
        }

        const wantIntercept = url.searchParams.get("intercept") === "1";

        for (const [, routerInstance] of registry) {
          if (!routerInstance.matchForPrerender) continue;
          try {
            const result = await routerInstance.matchForPrerender(pathname, {});
            if (!result) continue;
            res.setHeader("content-type", "application/json");
            let payload: Record<string, unknown>;
            if (wantIntercept && result.interceptSegments?.length) {
              payload = {
                segments: [...result.segments, ...result.interceptSegments],
                handles: {
                  ...result.handles,
                  ...(result.interceptHandles || {}),
                },
              };
            } else {
              payload = { segments: result.segments, handles: result.handles };
            }
            res.end(JSON.stringify(payload));
            return;
          } catch (err: any) {
            console.warn(
              `[rsc-router] Dev prerender failed for ${pathname}: ${err.message}`,
            );
          }
        }

        res.statusCode = 404;
        res.end("No prerender match");
      });

      // Watch url module and router files for changes and regenerate named-routes.gen.ts.
      // Process files containing urls( or createRouter( to update the combined route map.
      if (opts?.staticRouteTypesGeneration !== false) {
        const isGeneratedRouteFile = (filePath: string): boolean =>
          filePath.endsWith(".gen.ts") &&
          (filePath.includes("named-routes.gen.ts") ||
            filePath.includes("urls.gen.ts"));

        const regenerateGeneratedRouteFiles = () => {
          if (perRouterManifests.length > 0) {
            writeRouteTypesFiles();
          } else {
            writeCombinedRouteTypesWithTracking();
          }
        };

        const maybeHandleGeneratedRouteFileMutation = (
          filePath: string,
        ): boolean => {
          if (!isGeneratedRouteFile(filePath)) return false;
          if (consumeSelfGenWrite(filePath)) return true;
          regenerateGeneratedRouteFiles();
          return true;
        };

        // Debounce timer for batching rapid route-file changes (e.g. afterEach
        // restoring two files in quick succession). The cheap checks (extension,
        // scanFilter, content sniff) run synchronously to gate non-route files;
        // only the expensive regeneration is debounced.
        let routeChangeTimer: ReturnType<typeof setTimeout> | undefined;

        const scheduleRouteRegeneration = () => {
          clearTimeout(routeChangeTimer);
          routeChangeTimer = setTimeout(() => {
            routeChangeTimer = undefined;
            try {
              writeCombinedRouteTypesWithTracking();
              if (perRouterManifests.length > 0) {
                supplementGenFilesWithRuntimeRoutes();
              }
            } catch (err: any) {
              console.error(
                `[rsc-router] Route regeneration error: ${err.message}`,
              );
            }
          }, 100);
        };

        const handleRouteFileChange = (filePath: string) => {
          if (maybeHandleGeneratedRouteFileMutation(filePath)) return;
          if (
            !filePath.endsWith(".ts") &&
            !filePath.endsWith(".tsx") &&
            !filePath.endsWith(".js") &&
            !filePath.endsWith(".jsx")
          )
            return;
          // Apply scan filter as early-exit before reading file
          if (scanFilter && !scanFilter(filePath)) return;
          try {
            const source = readFileSync(filePath, "utf-8");
            const trimmed = source.trimStart();
            if (
              trimmed.startsWith('"use client"') ||
              trimmed.startsWith("'use client'")
            )
              return;
            const hasUrls = source.includes("urls(");
            const hasCreateRouter = /\bcreateRouter\s*[<(]/.test(source);
            if (!hasUrls && !hasCreateRouter) return;
            // Invalidate cache when a router file changes (new router added/removed)
            if (hasCreateRouter) {
              cachedRouterFiles = undefined;
            }
            scheduleRouteRegeneration();
          } catch {
            // Ignore read errors for deleted/moved files
          }
        };

        // Handle both "add" and "change" events: editors with atomic saves
        // (unlink + rename) emit "add" instead of "change", and chokidar's
        // polling mode on CI Linux can also emit "add" for overwrites.
        server.watcher.on("add", handleRouteFileChange);
        server.watcher.on("change", handleRouteFileChange);

        // Regenerate gen files when they are deleted (e.g. manual cleanup).
        server.watcher.on("unlink", (filePath) => {
          if (!isGeneratedRouteFile(filePath)) return;
          regenerateGeneratedRouteFiles();
        });
      }
    },

    // Build mode: create a temporary Vite dev server to access the RSC
    // environment's module runner, then discover routers and generate manifests.
    // The manifest data is stored for the virtual module's load hook.
    async buildStart() {
      if (!isBuildMode) return;
      // Only run once across environment builds
      if (mergedRouteManifest !== null) return;

      let tempServer: any = null;
      // Signal to user-space code (e.g. reverse.ts) that build-time discovery
      // is active. Uses globalThis because the temp server's module runner
      // creates a separate module context — there is no shared import path
      // between the vite plugin and user code loaded via runner.import().
      (globalThis as any).__rscRouterDiscoveryActive = true;
      try {
        // Create a minimal Vite server with just the RSC plugin.
        // We bypass the user's config file because:
        // - Custom environments (e.g., CloudflareDevEnvironment) may not expose
        //   a module runner compatible with runner.import()
        // - The temp server only needs RSC conditions to import the router
        const { default: rsc } = await import("@vitejs/plugin-rsc");
        tempServer = await createViteServer({
          root: projectRoot,
          configFile: false,
          server: { middlewareMode: true },
          appType: "custom",
          logLevel: "silent",
          // Use the resolved aliases from the real config (includes user's path aliases
          // like @/ -> src/ AND package aliases from rsc-router)
          resolve: { alias: userResolveAlias },
          // Enable automatic JSX runtime so .tsx files don't need `import React`.
          // Without this, esbuild defaults to classic mode (React.createElement)
          // which fails when lazy host-router handlers load sub-app modules with JSX.
          esbuild: { jsx: "automatic", jsxImportSource: "react" },
          plugins: [
            rsc({
              entries: {
                client: "virtual:entry-client",
                ssr: "virtual:entry-ssr",
                rsc: resolvedEntryPath!,
              },
            }),
            hashClientRefs(projectRoot),
            createVersionPlugin(),
            // Stub virtual modules that the RSC entry may import
            // (e.g., virtual:rsc-router/routes-manifest, virtual:rsc-router/loader-manifest)
            createVirtualStubPlugin(),
            // Inject handle + router IDs so prerender-collected handle data uses
            // the same hashed keys as the production client/SSR bundles, and
            // build-time router IDs match runtime IDs across environments.
            exposeInternalIds({ forceBuild: true }),
            exposeRouterId(),
          ],
        });

        const rscEnv = (tempServer.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          console.warn(
            "[rsc-router] RSC environment runner not available during build, skipping manifest generation",
          );
          return;
        }

        // Point resolvedStaticModules at the temp server's expose-internal-ids
        // plugin so that discoverRouters() can access the static handler module
        // map after the temp server's transforms populate it.
        const tempIdsPlugin = (tempServer as any).config?.plugins?.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        if (tempIdsPlugin?.api?.staticHandlerModules) {
          resolvedStaticModules = tempIdsPlugin.api.staticHandlerModules;
        }

        await discoverRouters(rscEnv);
        // Update named-routes.gen.ts from runtime discovery.
        // The runtime manifest includes dynamically generated routes
        // that the static parser cannot extract from source code.
        writeRouteTypesFiles();
      } catch (err: any) {
        // Extract the user source file from the stack trace (skip internal frames)
        const sourceFile = err.stack
          ?.split("\n")
          .find(
            (line: string) =>
              line.includes(projectRoot) && !line.includes("node_modules"),
          )
          ?.match(/\(([^)]+)\)/)?.[1];
        // Extract the route name from "Unknown route: <name>" errors
        const routeName = err.message?.match(/Unknown route: (.+)/)?.[1];
        const details = [
          routeName ? `  Route name: ${routeName}` : null,
          sourceFile ? `  File: ${sourceFile}` : null,
          err.stack ? `  Stack:\n${err.stack}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        throw new Error(
          `[rsc-router] Build-time router discovery failed:\n${details}`,
        );
      } finally {
        delete (globalThis as any).__rscRouterDiscoveryActive;
        if (tempServer) {
          await tempServer.close();
        }
      }
    },

    // Virtual module: provides the pre-generated route manifest as a JS module
    // that calls setCachedManifest() at import time.
    resolveId(id) {
      if (id === VIRTUAL_ROUTES_MANIFEST_ID) {
        return "\0" + VIRTUAL_ROUTES_MANIFEST_ID;
      }
      // Per-router virtual modules: virtual:rsc-router/routes-manifest/<routerId>
      if (id.startsWith(VIRTUAL_ROUTES_MANIFEST_ID + "/")) {
        return "\0" + id;
      }
      // virtual:rsc-router/prerender-paths removed: prerender data is served through the worker
      return null;
    },

    async load(id) {
      if (id === "\0" + VIRTUAL_ROUTES_MANIFEST_ID) {
        // In dev mode, wait for discovery to complete before emitting module content.
        // This is critical for Cloudflare dev where the worker runs in a separate
        // Miniflare process and can only receive manifest data via the virtual module.
        if (discoveryDone) {
          await discoveryDone;
        }
        const hasManifest =
          mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0;
        if (hasManifest) {
          // Build gen file import statements for each router with a sourceFile.
          // This creates a dependency in Vite's module graph: when the gen file
          // changes (e.g. after HMR route edits), Vite invalidates this virtual
          // module and re-evaluates it on the next request, calling
          // setCachedManifest() with fresh data. No manual sync needed.
          const genFileImports: string[] = [];
          const genFileVars: string[] = [];
          const routersWithoutGenFile: Array<{
            id: string;
            manifest: Record<string, string>;
          }> = [];
          let varIdx = 0;

          for (const entry of perRouterManifests) {
            if (entry.sourceFile) {
              const routerDir = dirname(entry.sourceFile);
              const routerBasename = basename(entry.sourceFile).replace(
                /\.(tsx?|jsx?)$/,
                "",
              );
              const genPath = join(
                routerDir,
                `${routerBasename}.named-routes.gen.js`,
              );
              const varName = `_r${varIdx++}`;
              genFileImports.push(
                `import { NamedRoutes as ${varName} } from ${JSON.stringify(genPath)};`,
              );
              genFileVars.push(varName);
            } else {
              // Routers without sourceFile: inline their manifest data directly
              routersWithoutGenFile.push({
                id: entry.id,
                manifest: entry.routeManifest,
              });
            }
          }

          const lines = [
            `import { setCachedManifest, setPrecomputedEntries, setRouteTrie, setRouterManifest, registerRouterManifestLoader, clearAllRouterData } from "@rangojs/router/server";`,
            ...genFileImports,
            // Clear stale per-router cached data (manifest, trie, precomputed entries)
            // before re-populating. In Cloudflare dev mode, program reloads re-evaluate
            // this virtual module but the route-map-builder singleton retains old data
            // because it's not in the HMR invalidation chain. Without this clear, the
            // handler finds stale trie data and never rebuilds from updated urlpatterns.
            `clearAllRouterData();`,
          ];

          // Flatten NamedRoutes entries: search schema objects -> plain string paths
          if (genFileVars.length > 0) {
            lines.push(
              `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
            );
          }

          // Build the merged manifest from gen file imports + inlined data
          if (genFileVars.length === 1 && routersWithoutGenFile.length === 0) {
            lines.push(`setCachedManifest(__flat(${genFileVars[0]}));`);
          } else {
            const parts: string[] = [];
            for (const v of genFileVars) parts.push(`...__flat(${v})`);
            for (const { manifest } of routersWithoutGenFile)
              parts.push(`...${jsonParseExpression(manifest)}`);
            lines.push(`setCachedManifest({ ${parts.join(", ")} });`);
          }

          // Set per-router manifests
          let genVarIdx = 0;
          for (const entry of perRouterManifests) {
            if (entry.sourceFile) {
              const varName = genFileVars[genVarIdx++];
              lines.push(
                `setRouterManifest(${JSON.stringify(entry.id)}, __flat(${varName}));`,
              );
            } else {
              lines.push(
                `setRouterManifest(${JSON.stringify(entry.id)}, ${jsonParseExpression(entry.routeManifest)});`,
              );
            }
          }

          // In dev mode, skip trie and precomputed entries injection. These are
          // computed once during initial discovery and become stale after route
          // changes. A stale trie would incorrectly match removed routes. The
          // handler falls back to Phase 2 regex matching against the live
          // router.urlpatterns, which is always correct after a program reload.
          // In build mode, the trie is always fresh (built from the final route
          // tree) so it's safe to inject.
          if (isBuildMode) {
            if (
              mergedPrecomputedEntries &&
              mergedPrecomputedEntries.length > 0
            ) {
              lines.push(
                `setPrecomputedEntries(${jsonParseExpression(mergedPrecomputedEntries)});`,
              );
            }
            if (mergedRouteTrie) {
              lines.push(
                `setRouteTrie(${jsonParseExpression(mergedRouteTrie)});`,
              );
            }
          }
          // Register lazy loaders for per-router manifest modules.
          // Each import() uses a static string literal so Rollup creates separate chunks.
          for (const routerId of perRouterManifestDataMap.keys()) {
            lines.push(
              `registerRouterManifestLoader(${JSON.stringify(routerId)}, () => import(${JSON.stringify(VIRTUAL_ROUTES_MANIFEST_ID + "/" + routerId)}));`,
            );
          }
          if (!isBuildMode && devServerOrigin) {
            lines.push(
              `globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(devServerOrigin)};`,
            );
          }
          return lines.join("\n");
        }
        // No manifest: either discovery hasn't completed or no runner (Cloudflare dev).
        // Still inject __PRERENDER_DEV_URL so the prerender store can fetch on-demand.
        // Re-resolve origin now since the server is listening by module load time.
        if (!isBuildMode) {
          const origin =
            devServerOrigin ||
            devServer?.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ||
            (devServer &&
              `http://localhost:${devServer.config.server.port || 5173}`);
          if (origin) {
            devServerOrigin = origin;
            return `globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(origin)};`;
          }
        }
        return `// Route manifest will be populated at runtime`;
      }
      // Per-router virtual modules: pure data exports (no side effects).
      // ensureRouterManifest() imports the module and stores the data.
      const perRouterPrefix = "\0" + VIRTUAL_ROUTES_MANIFEST_ID + "/";
      if (id.startsWith(perRouterPrefix)) {
        if (discoveryDone) {
          await discoveryDone;
        }
        const routerId = id.slice(perRouterPrefix.length);
        // Find the per-router entry to get the gen file path
        const routerEntry = perRouterManifests.find((e) => e.id === routerId);
        const trie = perRouterTrieMap.get(routerId);
        const entries = perRouterPrecomputedMap.get(routerId);
        const lines: string[] = [];

        if (routerEntry?.sourceFile) {
          // Import manifest from the gen file so HMR auto-propagates
          const routerDir = dirname(routerEntry.sourceFile);
          const routerBasename = basename(routerEntry.sourceFile).replace(
            /\.(tsx?|jsx?)$/,
            "",
          );
          const genPath = join(
            routerDir,
            `${routerBasename}.named-routes.gen.js`,
          );
          lines.push(
            `import { NamedRoutes as _r } from ${JSON.stringify(genPath)};`,
          );
          lines.push(
            `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
          );
          lines.push(`export const manifest = __flat(_r);`);
        } else {
          const manifest = perRouterManifestDataMap.get(routerId);
          if (manifest) {
            lines.push(
              `export const manifest = ${jsonParseExpression(manifest)};`,
            );
          }
        }
        if (trie) {
          lines.push(`export const trie = ${jsonParseExpression(trie)};`);
        }
        if (entries && entries.length > 0) {
          lines.push(
            `export const precomputedEntries = ${jsonParseExpression(entries)};`,
          );
        }
        return lines.join("\n") || "// empty router manifest";
      }
      // virtual:rsc-router/prerender-paths load handler removed
      return null;
    },

    // Record handler chunk metadata and RSC entry filename during RSC build.
    // Used by closeBundle for handler code eviction and prerender data injection.
    generateBundle(_options: any, bundle: any) {
      if (this.environment?.name !== "rsc") return;

      // Record RSC entry chunk filename for closeBundle injection
      for (const [fileName, chunk] of Object.entries(bundle) as [
        string,
        any,
      ][]) {
        if (chunk.type === "chunk" && chunk.isEntry) {
          rscEntryFileName = fileName;
          break;
        }
      }

      if (!resolvedPrerenderModules?.size && !resolvedStaticModules?.size)
        return;

      for (const [fileName, chunk] of Object.entries(bundle) as [
        string,
        any,
      ][]) {
        if (chunk.type !== "chunk") continue;

        // Prerender handlers chunk
        if (
          fileName.includes("__prerender-handlers") &&
          resolvedPrerenderModules?.size
        ) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code,
            resolvedPrerenderModules,
            "Prerender",
            true,
          );
          if (handlers.length > 0) {
            handlerChunkInfo = { fileName, exports: handlers };
          }
        }

        // Static handlers chunk
        if (
          fileName.includes("__static-handlers") &&
          resolvedStaticModules?.size
        ) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code,
            resolvedStaticModules,
            "Static",
            false,
          );
          if (handlers.length > 0) {
            staticHandlerChunkInfo = { fileName, exports: handlers };
          }
        }
      }
    },

    // Build-time pre-rendering: evict handler code and inject collected prerender data.
    // Collection now happens in-process during discoverRouters() via RSC runner.
    // closeBundle only needs to evict handlers and inject the in-memory data.
    closeBundle: {
      order: "post" as const,
      sequential: true,
      async handler(this: any) {
        if (!isBuildMode) return;
        // Only run for the RSC environment — other environments (client, ssr) have
        // no prerender/static data to process and would just do redundant file I/O.
        if (this.environment && this.environment.name !== "rsc") return;
        const hasPrerenderData =
          prerenderCollectedData &&
          Object.keys(prerenderCollectedData).length > 0;
        const hasStaticData =
          staticCollectedData && Object.keys(staticCollectedData).length > 0;
        if (!hasPrerenderData && !hasStaticData) return;

        // Find RSC entry (recorded in generateBundle, fallback to dist/rsc/index.js)
        const rscEntryPath = resolve(
          projectRoot,
          "dist/rsc",
          rscEntryFileName ?? "index.js",
        );

        // 1. Evict handler code from __prerender-handlers and __static-handlers chunks.
        // handlerChunkInfo/staticHandlerChunkInfo are populated by generateBundle
        // after the production RSC build. In Vite 6 multi-environment builds, the
        // RSC build runs twice (analysis + production). Chunk info is only available
        // after the production pass, so we run eviction whenever it becomes available.
        const evictionTargets: Array<{
          info: typeof handlerChunkInfo;
          fnName: string;
          brand: string;
          label: string;
        }> = [
          {
            info: handlerChunkInfo,
            fnName: "Prerender",
            brand: "prerenderHandler",
            label: "handler code from RSC bundle",
          },
          {
            info: staticHandlerChunkInfo,
            fnName: "Static",
            brand: "staticHandler",
            label: "static handler code",
          },
        ];

        for (const target of evictionTargets) {
          if (!target.info) continue;
          const chunkPath = resolve(
            projectRoot,
            "dist/rsc",
            target.info.fileName,
          );
          try {
            const code = readFileSync(chunkPath, "utf-8");
            const result = evictHandlerCode(
              code,
              target.info.exports,
              target.fnName,
              target.brand,
            );
            if (result) {
              writeFileSync(chunkPath, result.code);
              const savedKB = (result.savedBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Evicted ${target.label} (${savedKB} KB saved): ${target.info.fileName}`,
              );
            }
          } catch (replaceErr: any) {
            console.warn(
              `[rsc-router] Failed to evict ${target.label}: ${replaceErr.message}`,
            );
          }
        }
        handlerChunkInfo = null;
        staticHandlerChunkInfo = null;

        // 2. Write prerender data as separate importable asset modules
        // and inject a manifest import into the RSC entry.
        if (hasPrerenderData && existsSync(rscEntryPath)) {
          const rscCode = readFileSync(rscEntryPath, "utf-8");
          if (!rscCode.includes("__PRERENDER_MANIFEST")) {
            try {
              const assetsDir = resolve(projectRoot, "dist/rsc/assets");
              mkdirSync(assetsDir, { recursive: true });

              const manifestEntries: string[] = [];
              let totalBytes = 0;

              for (const [key, entry] of Object.entries(
                prerenderCollectedData!,
              )) {
                const entryJson = JSON.stringify(entry);
                const contentHash = createHash("sha256")
                  .update(entryJson)
                  .digest("hex")
                  .slice(0, 8);
                const assetFileName = `__pr-${contentHash}.js`;
                const assetPath = resolve(assetsDir, assetFileName);
                const assetCode = `export default ${entryJson};\n`;
                writeFileSync(assetPath, assetCode);
                totalBytes += Buffer.byteLength(assetCode);
                manifestEntries.push(
                  `${JSON.stringify(key)}:()=>import("./assets/${assetFileName}")`,
                );
              }

              const manifestCode = `const m={${manifestEntries.join(",")}};export default m;\n`;
              const manifestPath = resolve(
                projectRoot,
                "dist/rsc/__prerender-manifest.js",
              );
              writeFileSync(manifestPath, manifestCode);
              totalBytes += Buffer.byteLength(manifestCode);

              const injection = `import __pm from "./__prerender-manifest.js";\nglobalThis.__PRERENDER_MANIFEST = __pm;\n`;
              writeFileSync(rscEntryPath, injection + rscCode);

              const totalKB = (totalBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Wrote prerender assets (${totalKB} KB total, ${Object.keys(prerenderCollectedData!).length} entries)`,
              );
            } catch (err: any) {
              throw new Error(
                `[rsc-router] Failed to write prerender assets: ${err.message}`,
              );
            }
          }
        }

        // 3b. Write static handler data as separate importable asset modules
        // and inject a __STATIC_MANIFEST import into the RSC entry.
        if (hasStaticData && existsSync(rscEntryPath)) {
          const rscCode = readFileSync(rscEntryPath, "utf-8");
          if (!rscCode.includes("__STATIC_MANIFEST")) {
            try {
              const assetsDir = resolve(projectRoot, "dist/rsc/assets");
              mkdirSync(assetsDir, { recursive: true });

              const manifestEntries: string[] = [];
              let totalBytes = 0;

              for (const [handlerId, { encoded, handles }] of Object.entries(
                staticCollectedData!,
              )) {
                const contentHash = createHash("sha256")
                  .update(encoded)
                  .digest("hex")
                  .slice(0, 8);
                const assetFileName = `__st-${contentHash}.js`;
                const assetPath = resolve(assetsDir, assetFileName);
                // Store both the Flight payload and handle data
                const hasHandles = Object.keys(handles).length > 0;
                const exportValue = hasHandles
                  ? JSON.stringify({ encoded, handles })
                  : JSON.stringify(encoded);
                const assetCode = `export default ${exportValue};\n`;
                writeFileSync(assetPath, assetCode);
                totalBytes += Buffer.byteLength(assetCode);
                manifestEntries.push(
                  `${JSON.stringify(handlerId)}:()=>import("./assets/${assetFileName}")`,
                );
              }

              // Set the global inside the manifest module so it is assigned
              // during module evaluation (before dependent modules like
              // segment-resolution.ts run their top-level initializers).
              const manifestCode = `const m={${manifestEntries.join(",")}};globalThis.__STATIC_MANIFEST=m;export default m;\n`;
              const manifestPath = resolve(
                projectRoot,
                "dist/rsc/__static-manifest.js",
              );
              writeFileSync(manifestPath, manifestCode);
              totalBytes += Buffer.byteLength(manifestCode);

              // The import ensures the manifest module is evaluated early.
              // The global is already set inside the module itself.
              const injection = `import "./__static-manifest.js";\n`;
              writeFileSync(rscEntryPath, injection + rscCode);

              const totalKB = (totalBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Wrote static assets (${totalKB} KB total, ${Object.keys(staticCollectedData!).length} entries)`,
              );
            } catch (err: any) {
              throw new Error(
                `[rsc-router] Failed to write static assets: ${err.message}`,
              );
            }
          }
        }
      },
    },
  };
}
