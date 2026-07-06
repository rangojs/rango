/**
 * Prerender Collection
 *
 * Expands prerender routes into concrete URLs and renders them at build
 * time. Also handles Static handler rendering for segment-level static
 * generation.
 */

import { contextSet, hasContextVars } from "../../context-var.js";
import {
  encodePathParam,
  substituteRouteParams,
  runWithConcurrency,
  groupByConcurrency,
  notifyOnError,
  resolvePrerenderError,
  stageBuildAssetModule,
} from "../utils/prerender-utils.js";
import type { DiscoveryState } from "./state.js";
import { createRangoDebugger, NS } from "../debug.js";

const debug = createRangoDebugger(NS.prerender);

/**
 * Expand prerender routes into concrete URLs and render them via the
 * RSC runner. Stages asset modules and stores key-to-file entries in
 * state.prerenderManifestEntries.
 */
export async function expandPrerenderRoutes(
  state: DiscoveryState,
  rscEnv: any,
  registry: Map<string, any>,
  allManifests: Array<{ id: string; manifest: any }>,
): Promise<void> {
  if (!state.opts?.enableBuildPrerender || !state.isBuildMode) return;

  const overallStart = debug ? performance.now() : 0;
  debug?.(
    "expandPrerenderRoutes: start (%d router manifest(s))",
    allManifests.length,
  );

  type PrerenderEntry = {
    urlPath: string;
    routeName: string;
    concurrency: number;
    buildVars?: Record<string, any>;
    isPassthroughRoute?: boolean;
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

  let resolvedRoutes = 0;
  let totalDynamic = 0;

  // Count dynamic routes upfront for progress reporting
  for (const { manifest } of allManifests) {
    if (!manifest.prerenderRoutes) continue;
    for (const routeName of manifest.prerenderRoutes) {
      const pattern = manifest.routeManifest[routeName];
      if (pattern && (pattern.includes(":") || pattern.includes("*"))) {
        totalDynamic++;
      }
    }
  }

  // Periodic progress log so long getParams() calls don't look stalled
  const paramsStart = performance.now();
  const progressInterval =
    totalDynamic > 0
      ? setInterval(() => {
          const elapsed = ((performance.now() - paramsStart) / 1000).toFixed(1);
          console.log(
            `[rango] Resolving prerender params... ${resolvedRoutes}/${totalDynamic} routes (${elapsed}s)`,
          );
        }, 5000)
      : undefined;

  try {
    for (const { manifest } of allManifests) {
      if (!manifest.prerenderRoutes) continue;
      const defs = manifest._prerenderDefs || {};
      const passthroughSet = new Set(manifest.passthroughRoutes || []);
      for (const routeName of manifest.prerenderRoutes) {
        const pattern = manifest.routeManifest[routeName];
        if (!pattern) continue;
        const def = defs[routeName];
        const isPassthroughRoute = passthroughSet.has(routeName);
        const hasDynamic = pattern.includes(":") || pattern.includes("*");
        if (!hasDynamic) {
          // Static route: use pattern directly (strip trailing slash for URL)
          entries.push({
            urlPath: pattern.replace(/\/$/, "") || "/",
            routeName,
            concurrency: 1,
            isPassthroughRoute,
          });
        } else {
          // Dynamic route: call getParams() to enumerate param combinations
          if (def?.getParams) {
            const getParamsStart = debug ? performance.now() : 0;
            try {
              const buildVars: Record<string, any> = {};
              const buildEnv = state.resolvedBuildEnv;
              const getParamsCtx = {
                build: true as const,
                dev: !state.isBuildMode,
                set: ((keyOrVar: any, value: any) => {
                  contextSet(buildVars, keyOrVar, value);
                }) as any,
                reverse: getParamsReverse,
                get env() {
                  if (buildEnv !== undefined) return buildEnv;
                  throw new Error(
                    "[rango] ctx.env is not available during build-time getParams(). " +
                      "Configure buildEnv in your rango() plugin options to enable build-time env access.",
                  );
                },
              };
              const paramsList = await def.getParams(getParamsCtx);
              debug?.(
                "getParams %s -> %d params (%sms)",
                routeName,
                paramsList.length,
                (performance.now() - getParamsStart).toFixed(1),
              );
              const concurrency = def.options?.concurrency ?? 1;
              const hasBuildVars = hasContextVars(buildVars);
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
                  isPassthroughRoute,
                });
              }
              resolvedRoutes++;
            } catch (err: any) {
              resolvedRoutes++;
              // Skip in getParams() skips the entire route
              if (err.name === "Skip") {
                console.log(
                  `[rango]   SKIP route "${routeName}" - ${err.message}`,
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
                `[rango] Failed to get params for prerender route "${routeName}": ${err.message}`,
              );
              notifyOnError(registry, err, "prerender", routeName);
              throw err;
            }
          } else {
            console.warn(
              `[rango] Dynamic prerender route "${routeName}" has no getParams(), skipping`,
            );
          }
        }
      }
    }
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
      const elapsed = ((performance.now() - paramsStart) / 1000).toFixed(1);
      console.log(
        `[rango] Resolved prerender params: ${resolvedRoutes}/${totalDynamic} routes (${elapsed}s)`,
      );
    }
  }

  if (entries.length === 0) {
    debug?.(
      "no prerender entries (done in %sms)",
      (performance.now() - overallStart).toFixed(1),
    );
    return;
  }

  // Determine the max concurrency for the log header
  const maxConcurrency = Math.max(...entries.map((e) => e.concurrency));
  const concurrencyNote =
    maxConcurrency > 1 ? ` (concurrency: ${maxConcurrency})` : "";
  console.log(
    `[rango] Pre-rendering ${entries.length} URL(s)${concurrencyNote}...`,
  );
  debug?.(
    "prerender loop: %d entries, max concurrency %d",
    entries.length,
    maxConcurrency,
  );

  const { hashParams } = await rscEnv.runner.import("@rangojs/router/build");

  const manifestEntries: Record<string, string> = {};
  let doneCount = 0;
  let skipCount = 0;
  // #587: a render error reaches here (matchForPrerender now re-throws it rather
  // than baking the error boundary). Default "fail" fails the build; "warn" logs
  // and skips baking the URL.
  const prerenderOnError = state.opts?.prerenderOnError ?? "fail";
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
              entry.isPassthroughRoute,
              state.resolvedBuildEnv,
            );
            if (!result) continue;

            // Handler returned ctx.passthrough() — skip manifest entry
            if (result.passthrough) {
              const elapsed = (performance.now() - startUrl).toFixed(0);
              console.log(
                `[rango]   PASS ${entry.urlPath.padEnd(40)} (${elapsed}ms) - live fallback`,
              );
              doneCount++;
              break;
            }

            const paramHash = hashParams(result.params || {});
            const mainKey = `${result.routeName}/${paramHash}`;
            const mainValue = JSON.stringify({
              segments: result.segments,
              handles: result.handles,
            });
            manifestEntries[mainKey] = stageBuildAssetModule(
              state.projectRoot,
              "__pr",
              mainValue,
            );
            // Prerender + ppr composition: flag the URL as a build-time shell
            // candidate for the post-build capture phase (producer B, #699).
            // The payload JSON is retained in memory so that phase can seed an
            // in-realm prerender store the capture's match() will HIT.
            if (result.ppr !== undefined && result.ppr !== false) {
              (state.shellCandidates ??= []).push({
                urlPath: entry.urlPath,
                routeName: result.routeName,
                paramHash,
                ppr: result.ppr === true ? true : result.ppr,
              });
              (state.prerenderPayloadValues ??= new Map()).set(
                mainKey,
                mainValue,
              );
            }
            if (result.interceptSegments?.length) {
              const interceptKey = `${result.routeName}/${paramHash}/i`;
              const interceptValue = JSON.stringify({
                segments: [...result.segments, ...result.interceptSegments],
                // interceptHandles is the pre-encoded MERGED (main + intercept)
                // handle string (the producer merged before encoding).
                handles: result.interceptHandles ?? "",
              });
              manifestEntries[interceptKey] = stageBuildAssetModule(
                state.projectRoot,
                "__pr",
                interceptValue,
              );
            }
            const elapsed = (performance.now() - startUrl).toFixed(0);
            console.log(
              `[rango]   OK   ${entry.urlPath.padEnd(40)} (${elapsed}ms)`,
            );
            doneCount++;
            break;
          } catch (err: any) {
            // Skip, or a render error under prerender.onError "warn": skip the
            // URL (never bake the error page, #587). A render error under the
            // default "fail" re-throws below to fail the build.
            const elapsed = (performance.now() - startUrl).toFixed(0);
            resolvePrerenderError(
              registry,
              err,
              prerenderOnError,
              entry.urlPath.padEnd(40),
              elapsed,
              "prerender",
              entry.routeName,
              entry.urlPath,
            );
            skipCount++;
            break;
          }
        }
      },
    );
  }

  const totalElapsed = (performance.now() - startTotal).toFixed(0);
  if (doneCount > 0) {
    state.prerenderManifestEntries = manifestEntries;
  }
  const parts = [`${doneCount} done`];
  if (skipCount > 0) parts.push(`${skipCount} skipped`);
  console.log(
    `[rango] Pre-render complete: ${parts.join(", ")} (${totalElapsed}ms total)`,
  );
  debug?.(
    "expandPrerenderRoutes done: %d done, %d skipped, %sms (overall %sms)",
    doneCount,
    skipCount,
    totalElapsed,
    (performance.now() - overallStart).toFixed(1),
  );
}

/**
 * Render Static handlers at build time. Each Static handler is called
 * with a synthetic BuildContext and its output is RSC-serialized.
 * Stages asset modules and stores handlerId-to-file entries in
 * state.staticManifestEntries.
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

  const overallStart = debug ? performance.now() : 0;
  debug?.(
    "renderStaticHandlers: start (%d static module(s))",
    state.resolvedStaticModules.size,
  );

  const manifestEntries: Record<string, string> = {};
  let staticDone = 0;
  let staticSkip = 0;
  let totalStaticCount = 0;
  const prerenderOnError = state.opts?.prerenderOnError ?? "fail";

  // Count handlers for the log header
  for (const [, exportNames] of state.resolvedStaticModules) {
    totalStaticCount += exportNames.length;
  }
  const startStatic = performance.now();
  console.log(`[rango] Rendering ${totalStaticCount} static handler(s)...`);

  for (const [moduleId, exportNames] of state.resolvedStaticModules) {
    let mod: any;
    try {
      mod = await rscEnv!.runner.import(moduleId);
    } catch (err: any) {
      console.error(
        `[rango] Failed to import static module ${moduleId}: ${err.message}`,
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
            state.resolvedBuildEnv,
            !state.isBuildMode,
          );
          if (result) {
            // result.handles is the pre-encoded handle string ("" when none).
            const hasHandles = result.handles !== "";
            const exportValue = hasHandles
              ? JSON.stringify(result)
              : JSON.stringify(result.encoded);
            manifestEntries[def.$$id] = stageBuildAssetModule(
              state.projectRoot,
              "__st",
              exportValue,
            );
            const elapsed = (performance.now() - startHandler).toFixed(0);
            console.log(`[rango]   OK   ${name.padEnd(40)} (${elapsed}ms)`);
            staticDone++;
            handled = true;
            break;
          }
        } catch (err: any) {
          // Same Skip/warn/fail policy as the prerender loop (shared helper).
          const elapsed = (performance.now() - startHandler).toFixed(0);
          resolvePrerenderError(
            registry,
            err,
            prerenderOnError,
            name.padEnd(40),
            elapsed,
            "static",
          );
          staticSkip++;
          handled = true;
          break;
        }
      }
      if (!handled) {
        console.warn(`[rango] No router could render static handler "${name}"`);
      }
    }
  }

  const totalStaticElapsed = (performance.now() - startStatic).toFixed(0);
  if (staticDone > 0) {
    state.staticManifestEntries = manifestEntries;
  }
  const staticParts = [`${staticDone} done`];
  if (staticSkip > 0) staticParts.push(`${staticSkip} skipped`);
  console.log(
    `[rango] Static render complete: ${staticParts.join(", ")} (${totalStaticElapsed}ms total)`,
  );
  debug?.(
    "renderStaticHandlers done: %d done, %d skipped, %sms (overall %sms)",
    staticDone,
    staticSkip,
    totalStaticElapsed,
    (performance.now() - overallStart).toFixed(1),
  );
}
