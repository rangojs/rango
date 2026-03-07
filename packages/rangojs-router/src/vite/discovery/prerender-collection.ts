/**
 * Prerender Collection
 *
 * Expands prerender routes into concrete URLs and renders them at build
 * time. Also handles Static handler rendering for segment-level static
 * generation.
 */

import { contextSet } from "../../context-var.js";
import {
  encodePathParam,
  substituteRouteParams,
  runWithConcurrency,
  groupByConcurrency,
  notifyOnError,
} from "../utils/prerender-utils.js";
import type { DiscoveryState } from "./state.js";

/**
 * Expand prerender routes into concrete URLs and render them via the
 * RSC runner. Stores collected data in state.prerenderCollectedData.
 */
export async function expandPrerenderRoutes(
  state: DiscoveryState,
  rscEnv: any,
  registry: Map<string, any>,
  allManifests: Array<{ id: string; manifest: any }>,
): Promise<void> {
  if (!state.opts?.enableBuildPrerender || !state.isBuildMode) return;

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
  const getParamsReverse = (name: string, params?: Record<string, string>) => {
    const pattern = allRoutes[name];
    if (!pattern) throw new Error(`Unknown route: "${name}"`);
    if (!params) return pattern;
    return substituteRouteParams(pattern, params);
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
              let url = substituteRouteParams(
                pattern,
                params as Record<string, string>,
                encodePathParam,
              );
              // Anonymous wildcard fallback: use conventional keys if provided
              if (url.includes("*")) {
                const wildcardValue =
                  (params as Record<string, string>)["*"] ??
                  (params as Record<string, string>).splat;
                if (wildcardValue !== undefined) {
                  url = url.replace(/\*[^/]*$/, encodePathParam(wildcardValue));
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

  if (entries.length === 0) return;

  // Determine the max concurrency for the log header
  const maxConcurrency = Math.max(...entries.map((e) => e.concurrency));
  const concurrencyNote =
    maxConcurrency > 1 ? ` (concurrency: ${maxConcurrency})` : "";
  console.log(
    `[rsc-router] Pre-rendering ${entries.length} URL(s)${concurrencyNote}...`,
  );

  const { hashParams } = await rscEnv.runner.import("@rangojs/router/build");

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
                segments: [...result.segments, ...result.interceptSegments],
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
    state.prerenderCollectedData = collectedData;
  }
  const parts = [`${doneCount} done`];
  if (skipCount > 0) parts.push(`${skipCount} skipped`);
  console.log(
    `[rsc-router] Pre-render complete: ${parts.join(", ")} (${totalElapsed}ms total)`,
  );
}

/**
 * Render Static handlers at build time. Each Static handler is called
 * with a synthetic BuildContext and its output is RSC-serialized.
 * Stores collected data in state.staticCollectedData.
 */
export async function renderStaticHandlers(
  state: DiscoveryState,
  rscEnv: any,
  registry: Map<string, any>,
): Promise<void> {
  if (
    !state.opts?.enableBuildPrerender ||
    !state.isBuildMode ||
    !state.resolvedStaticModules?.size
  )
    return;

  const collected: Record<
    string,
    { encoded: string; handles: Record<string, unknown[]> }
  > = {};
  let staticDone = 0;
  let staticSkip = 0;
  let totalStaticCount = 0;

  // Count handlers for the log header
  for (const [, exportNames] of state.resolvedStaticModules) {
    totalStaticCount += exportNames.length;
  }
  const startStatic = performance.now();
  console.log(
    `[rsc-router] Rendering ${totalStaticCount} static handler(s)...`,
  );

  for (const [moduleId, exportNames] of state.resolvedStaticModules) {
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
            notifyOnError(registry, err, "static", undefined, undefined, true);
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
    state.staticCollectedData = collected;
  }
  const staticParts = [`${staticDone} done`];
  if (staticSkip > 0) staticParts.push(`${staticSkip} skipped`);
  console.log(
    `[rsc-router] Static render complete: ${staticParts.join(", ")} (${totalStaticElapsed}ms total)`,
  );
}
