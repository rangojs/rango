import { type ReactNode } from "react";
import { createHandleStore } from "../server/handle-store.js";
import { getRequestContext } from "../server/request-context.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { contextGet, contextSet } from "../context-var.js";
import {
  createPrerenderContext,
  createStaticContext,
  createReverseFunction,
} from "./handler-context.js";
import { isPrerenderPassthrough } from "../prerender.js";
import { isRouteRootScoped } from "../route-map-builder.js";
import { setupBuildUse } from "./loader-resolution.js";
import { loadManifest } from "./manifest.js";
import { traverseBack } from "./pattern-matching.js";
import type { RouterContext } from "./router-context.js";
import { runWithRouterContext } from "./router-context.js";
import type { EntryData, InterceptEntry } from "../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
} from "../types";
import type {
  SerializedSegmentData,
  SegmentHandleData,
} from "../cache/types.js";
import type { RouteMatchResult } from "./pattern-matching.js";

export interface PrerenderMatchDeps<TEnv = any> {
  findMatch: (pathname: string) => RouteMatchResult<TEnv> | null;
  buildRouterContext: () => RouterContext<TEnv>;
  mergedRouteMap: Record<string, string>;
  resolveAllSegments: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: { skipLoaders?: boolean },
  ) => Promise<ResolvedSegment[]>;
}

/**
 * Build-time pre-render match. Resolves segments with a BuildContext
 * (no request/env/headers/cookies), skipping middleware and loaders.
 */
export async function matchForPrerender<TEnv = any>(
  pathname: string,
  params: Record<string, string>,
  deps: PrerenderMatchDeps<TEnv>,
  buildVars?: Record<string, any>,
  isPassthroughRoute?: boolean,
  buildEnv?: TEnv,
  /** Dev-only: check getParams() for passthrough routes to skip unknown params. */
  devMode?: boolean,
): Promise<{
  segments: SerializedSegmentData[];
  /** RSC-encoded handle map ("" when none) — see handle-snapshot.ts. Encoded in
   *  the producer (where the Flight codec resolves) so the node-side build/dev
   *  sinks can persist it without touching the codec. */
  handles: string;
  routeName: string;
  params: Record<string, string>;
  interceptSegments?: SerializedSegmentData[];
  /** RSC-encoded MERGED (main + intercept) handle map for the intercept artifact;
   *  the sinks store it as-is (no longer merge raw records). */
  interceptHandles?: string;
  passthrough?: true;
} | null> {
  // 1. Find the matching route entry
  const matched = deps.findMatch(pathname);
  if (!matched) return null;

  // Use params from trie match if available, fall back to provided params
  const matchedParams = matched.params ?? params;
  const matchedPassthroughRoute = isPassthroughRoute ?? matched.pt === true;

  // Build RouterContext for loadManifest/traverseBack
  const routerCtx = deps.buildRouterContext();

  return runWithRouterContext(routerCtx, async () => {
    // 2. Load the manifest entry tree
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      undefined,
      false,
    );

    // 3. Build ancestor chain [root, ..., route]
    const entries: EntryData[] = [];
    for (const entry of traverseBack(manifestEntry)) {
      entries.push(entry);
    }

    // 3b. Dev-mode passthrough shortcut: if the route is a Passthrough route
    // and has getParams(), check if the matched params are in the known list.
    // In production, only known params are pre-rendered; unknown params fall
    // through to the live handler. Mirror that behavior in dev mode to avoid
    // rendering unknown params with build: true.
    // Vars collected from getParams() probe — merged into render context below.
    let devProbeBuildVars: Record<string, any> | undefined;

    if (devMode && matchedPassthroughRoute) {
      const routeEntry = entries.find(
        (
          e,
        ): e is EntryData & {
          type: "route";
          prerenderDef: { getParams: (ctx: any) => Promise<any[]> | any[] };
        } =>
          e.type === "route" &&
          !!(e as any).isPassthrough &&
          !!(e as any).prerenderDef?.getParams,
      );
      if (routeEntry) {
        try {
          const probeBuildVars: Record<string, any> = {};
          const knownParamsList = await routeEntry.prerenderDef.getParams({
            build: true as const,
            dev: true,
            set: ((keyOrVar: any, value: any) => {
              contextSet(probeBuildVars, keyOrVar, value);
            }) as any,
            reverse: createReverseFunction(deps.mergedRouteMap),
            get env() {
              if (buildEnv !== undefined) return buildEnv;
              throw new Error(
                "[rango] ctx.env is not available during dev-mode getParams(). " +
                  "Configure buildEnv in your rango() plugin options to enable build-time env access.",
              );
            },
          });
          // Compare only the keys returned by getParams — ignore mount params
          // from include() prefixes that aren't part of the handler's params.
          const isKnown = knownParamsList.some((known: Record<string, any>) => {
            const knownKeys = Object.keys(known);
            return knownKeys.every(
              (k) => String(known[k]) === String(matchedParams[k]),
            );
          });
          if (!isKnown) {
            return {
              segments: [],
              handles: "",
              routeName: matched.routeKey,
              params: matchedParams,
              passthrough: true as const,
            };
          }
          // Preserve vars set by getParams() for the render context
          if (
            Object.keys(probeBuildVars).length > 0 ||
            Object.getOwnPropertySymbols(probeBuildVars).length > 0
          ) {
            devProbeBuildVars = probeBuildVars;
          }
        } catch (err: any) {
          // Mirror production semantics (prerender-collection.ts):
          // Skip errors are intentional — treat as passthrough.
          // All other errors propagate so dev surfaces them.
          if (err?.name === "Skip") {
            return {
              segments: [],
              handles: "",
              routeName: matched.routeKey,
              params: matchedParams,
              passthrough: true as const,
            };
          }
          throw err;
        }
      }
    }

    // 4. Create handle store for collecting handle data
    const handleStore = createHandleStore();

    // 5. Create a minimal request context with the handle store
    // Shallow-copy getParams vars so each param set is independent.
    // In dev mode, merge vars from the getParams() probe if the caller
    // didn't provide buildVars (production passes them from expandPrerenderRoutes).
    const effectiveBuildVars = buildVars ?? devProbeBuildVars;
    const variables: Record<string, any> = effectiveBuildVars
      ? { ...effectiveBuildVars }
      : {};
    const stubRes = new Response(null, { status: 200 });
    const minimalRequestContext: RequestContext<TEnv> = {
      env: buildEnv ?? ({} as TEnv),
      request: new Request("http://prerender" + pathname),
      url: new URL("http://prerender" + pathname),
      originalUrl: new URL("http://prerender" + pathname),
      pathname,
      searchParams: new URLSearchParams(),
      _variables: variables,
      get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
      set: ((keyOrVar: any, value: any) => {
        contextSet(variables, keyOrVar, value);
      }) as any,
      params: matchedParams,
      res: stubRes,
      cookie: () => undefined,
      cookies: () => ({}),
      setCookie: () => {},
      deleteCookie: () => {},
      header: () => {},
      setStatus: () => {},
      _setStatus: () => {},
      use: (() => {
        throw new Error("use() not available during pre-rendering");
      }) as any,
      method: "GET",
      _handleStore: handleStore,
      waitUntil: () => {},
      onResponse: () => {},
      _onResponseCallbacks: [],
      setLocationState() {},
      _locationState: undefined,
      _renderBarrier: Promise.resolve(),
      _resolveRenderBarrier: () => {},
      _reportedErrors: new WeakSet<object>(),
      reverse: createReverseFunction(
        deps.mergedRouteMap,
        matched.routeKey,
        matchedParams,
        matched.routeKey ? isRouteRootScoped(matched.routeKey) : undefined,
      ),
    };

    return runWithRequestContext(minimalRequestContext, async () => {
      // 6. Create prerender context with synthetic URL.
      // Prerender handlers get params, pathname, url, searchParams, search,
      // reverse, use(handle), and optionally env (when buildEnv is configured).
      const buildCtx = createPrerenderContext<TEnv>(
        matchedParams,
        pathname,
        deps.mergedRouteMap,
        matched.routeKey,
        variables,
        matchedPassthroughRoute,
        buildEnv,
        devMode,
      );

      // 7. Wire use() for handles only (loaders throw)
      setupBuildUse(buildCtx);

      // 8. Resolve all segments with skipLoaders
      const loaderPromises = new Map<string, Promise<any>>();
      const allSegments = await deps.resolveAllSegments(
        entries,
        matched.routeKey,
        matchedParams,
        buildCtx,
        loaderPromises,
        { skipLoaders: true },
      );

      // 9. Detect passthrough sentinel: handler returned ctx.passthrough()
      for (const seg of allSegments) {
        if (isPrerenderPassthrough(seg.component)) {
          return {
            segments: [],
            handles: "",
            routeName: matched.routeKey,
            params: matchedParams,
            passthrough: true as const,
          };
        }
      }

      // 10. Filter out any loader segments (belt-and-suspenders)
      const nonLoaderSegments = allSegments.filter((s) => s.type !== "loader");

      // 11. Wait for handles to settle
      handleStore.seal();
      await handleStore.settled;

      // 12. Serialize segments using the cache serializer
      const { serializeSegments } = await import("../cache/segment-codec.js");
      const { encodeHandles } = await import("../cache/handle-snapshot.js");
      const serializedSegments = await serializeSegments(nonLoaderSegments);

      // 13. Collect handle data per segment (skip segments with no handle data).
      // Encoded through the Flight codec (not stored raw) so Promise/ReactNode
      // handle values survive the JSON-serialized build artifact / dev wire —
      // the same fix the runtime cache uses. Encode happens here, in the RSC
      // environment where the codec resolves; the node-side sinks only persist.
      const handlesRecord: Record<string, SegmentHandleData> = {};
      for (const seg of nonLoaderSegments) {
        const segHandles = handleStore.getDataForSegment(seg.id);
        if (Object.keys(segHandles).length > 0) {
          handlesRecord[seg.id] = segHandles;
        }
      }
      const handles = await encodeHandles(handlesRecord);

      // Use the trie-level route key (e.g., "docs", "docs.article")
      const routeName = matched.routeKey;

      // 14. Resolve intercept segments for this route (if any ancestor defines
      //     an intercept targeting this route). At build time we skip when()
      //     evaluation -- we pre-render all intercepts unconditionally and let
      //     runtime matching decide which to serve.
      let interceptSegments: SerializedSegmentData[] | undefined;
      let interceptHandles: string | undefined;

      const foundIntercepts: {
        intercept: InterceptEntry;
        entry: EntryData;
      }[] = [];
      let current: EntryData | null = manifestEntry;
      while (current) {
        if (current.intercept && current.intercept.length > 0) {
          for (const ic of current.intercept) {
            if (ic.routeName === matched.routeKey) {
              foundIntercepts.push({ intercept: ic, entry: current });
            }
          }
        }
        if (current.layout && current.layout.length > 0) {
          for (const siblingLayout of current.layout) {
            if (siblingLayout.intercept && siblingLayout.intercept.length > 0) {
              for (const ic of siblingLayout.intercept) {
                if (ic.routeName === matched.routeKey) {
                  foundIntercepts.push({
                    intercept: ic,
                    entry: siblingLayout,
                  });
                }
              }
            }
          }
        }
        current = current.parent;
      }

      if (foundIntercepts.length > 0) {
        const interceptResolvedSegments: typeof nonLoaderSegments = [];

        for (const { intercept, entry: parentEntry } of foundIntercepts) {
          // Resolve handler
          const handlerRaw =
            typeof intercept.handler === "function"
              ? intercept.handler(buildCtx)
              : intercept.handler;
          const handlerResolved =
            handlerRaw instanceof Promise ? await handlerRaw : handlerRaw;
          if (handlerResolved instanceof Response) {
            // Handler returned a redirect/response -- skip this intercept
            continue;
          }
          const component: ReactNode = handlerResolved;

          // Resolve layout (if any)
          let layoutElement: ReactNode | undefined;
          if (intercept.layout) {
            if (typeof intercept.layout === "function") {
              const layoutResult = await intercept.layout(buildCtx);
              if (layoutResult instanceof Response) continue;
              layoutElement = layoutResult;
            } else {
              layoutElement = intercept.layout;
            }
          }

          interceptResolvedSegments.push({
            id: `${parentEntry.shortCode}.${intercept.slotName}`,
            namespace: `intercept:${intercept.routeName}`,
            type: "parallel" as const,
            index: 0,
            component,
            loading: intercept.loading === false ? null : intercept.loading,
            layout: layoutElement,
            params: matchedParams,
            slot: intercept.slotName,
            belongsToRoute: true,
            parallelName: `intercept:${intercept.routeName}.${intercept.slotName}`,
          });
        }

        if (interceptResolvedSegments.length > 0) {
          // Wait for handles again (intercept handlers may have called use())
          await handleStore.settled;
          interceptSegments = await serializeSegments(
            interceptResolvedSegments,
          );
          const interceptHandlesRecord: Record<string, SegmentHandleData> = {};
          for (const seg of interceptResolvedSegments) {
            const segHandles = handleStore.getDataForSegment(seg.id);
            if (Object.keys(segHandles).length > 0) {
              interceptHandlesRecord[seg.id] = segHandles;
            }
          }
          // The intercept artifact serves main + intercept segments together, so
          // encode the MERGED handle map here (the sinks no longer merge raw
          // records — they store this pre-encoded string as-is).
          interceptHandles = await encodeHandles({
            ...handlesRecord,
            ...interceptHandlesRecord,
          });
        }
      }

      return {
        segments: serializedSegments,
        handles,
        routeName,
        params: matchedParams,
        interceptSegments,
        interceptHandles,
      };
    });
  });
}

/**
 * Render a single Static handler at build time.
 * Creates a minimal BuildContext, calls the handler, and RSC-serializes
 * the component. Returns the encoded Flight string (or null on failure).
 * Used by the Vite plugin to collect static segment data at build time.
 */
export async function renderStaticSegment<TEnv = any>(
  handler: Function,
  handlerId: string,
  mergedRouteMap: Record<string, string>,
  routeName?: string,
  buildEnv?: TEnv,
  devMode?: boolean,
): Promise<{ encoded: string; handles: string } | null> {
  const syntheticUrl = new URL("http://prerender/");
  const syntheticRequest = new Request(syntheticUrl);

  // Create a HandleStore to capture handle data pushed during rendering
  const handleStore = createHandleStore();

  // Minimal request context so setupBuildUse can find the HandleStore
  const stubRes = new Response(null, { status: 200 });
  const minimalRequestContext: RequestContext<TEnv> = {
    env: buildEnv ?? ({} as TEnv),
    request: syntheticRequest,
    url: syntheticUrl,
    originalUrl: syntheticUrl,
    pathname: "/",
    searchParams: syntheticUrl.searchParams,
    _variables: {},
    get: () => undefined as any,
    set: () => {},
    params: {},
    res: stubRes,
    cookie: () => undefined,
    cookies: () => ({}),
    setCookie: () => {},
    deleteCookie: () => {},
    header: () => {},
    setStatus: () => {},
    _setStatus: () => {},
    use: (() => {
      throw new Error("use() not available during static pre-rendering");
    }) as any,
    method: "GET",
    _handleStore: handleStore,
    waitUntil: () => {},
    onResponse: () => {},
    _onResponseCallbacks: [],
    setLocationState() {},
    _locationState: undefined,
    _renderBarrier: Promise.resolve(),
    _resolveRenderBarrier: () => {},
    _reportedErrors: new WeakSet<object>(),
    reverse: createReverseFunction(
      mergedRouteMap,
      routeName,
      {},
      routeName ? isRouteRootScoped(routeName) : undefined,
    ),
  };

  return runWithRequestContext(minimalRequestContext, async () => {
    // Static handlers get only reverse, use(handle), and optionally env.
    const buildCtx = createStaticContext<TEnv>(
      mergedRouteMap,
      routeName,
      buildEnv,
      devMode,
    );

    // Set segment ID so handle pushes are keyed correctly
    (buildCtx as InternalHandlerContext<any, TEnv>)._currentSegmentId =
      handlerId;

    setupBuildUse(buildCtx);

    const raw = await handler(buildCtx);
    const component = raw?.type ? raw : raw;

    const segment: ResolvedSegment = {
      id: handlerId,
      namespace: handlerId,
      type: "layout",
      index: 0,
      component,
      params: {},
      belongsToRoute: false,
    };

    const { serializeSegments } = await import("../cache/segment-codec.js");
    const { encodeHandleValue } = await import("../cache/handle-snapshot.js");
    const [serialized] = await serializeSegments([segment]);

    // Collect handle data pushed during rendering and Flight-encode it (so
    // Promise/ReactNode handle values survive the JSON build artifact). "" when
    // nothing was pushed.
    const segHandles = handleStore.getDataForSegment(handlerId);
    const handles =
      Object.keys(segHandles).length > 0
        ? await encodeHandleValue(segHandles)
        : "";

    return { encoded: serialized.encoded, handles };
  });
}
