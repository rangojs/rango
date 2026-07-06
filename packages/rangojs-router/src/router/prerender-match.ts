import { type ReactNode } from "react";
import { createHandleStore } from "../server/handle-store.js";
import { resolveSegmentHandleValues } from "../handles/deferred-resolution.js";
import { getRequestContext } from "../server/request-context.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { contextGet, contextSet, hasContextVars } from "../context-var.js";
import {
  createPrerenderContext,
  createStaticContext,
  createReverseFunction,
} from "./handler-context.js";
import { detectPrerenderPassthrough } from "../prerender.js";
import { isRouteRootScoped } from "../route-map-builder.js";
import { setupBuildUse } from "./loader-resolution.js";
import { loadManifest } from "./manifest.js";
import { traverseBack } from "./pattern-matching.js";
import type { RouterContext } from "./router-context.js";
import type { ResolveSegmentOptions } from "./segment-resolution.js";
import { runWithRouterContext } from "./router-context.js";
import type { EntryData, InterceptEntry } from "../server/context";
import type { PartialPrerenderProps } from "../urls/pattern-types.js";
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
  findMatch: (
    pathname: string,
  ) => RouteMatchResult<TEnv> | null | Promise<RouteMatchResult<TEnv> | null>;
  buildRouterContext: () => RouterContext<TEnv>;
  mergedRouteMap: Record<string, string>;
  resolveAllSegments: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: ResolveSegmentOptions,
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
  /**
   * The matched route entry's `ppr` path option, surfaced so the build
   * collection can flag Prerender+ppr routes as build-time shell candidates
   * (issue #699 producer B). Runtime-only today; the build otherwise never
   * sees the option (it lives on EntryData, not the trie).
   */
  ppr?: boolean | PartialPrerenderProps;
} | null> {
  // 1. Find the matching route entry
  const matched = await deps.findMatch(pathname);
  if (!matched) return null;

  // Use params from trie match if available, fall back to provided params
  const matchedParams = matched.params ?? params;
  const matchedPassthroughRoute = isPassthroughRoute ?? matched.pt === true;

  // Build RouterContext for loadManifest/traverseBack
  const routerCtx = deps.buildRouterContext();

  // Passthrough sentinel result: an unknown-param Passthrough route falls
  // through to the live handler at runtime, so no artifact is baked. A fresh
  // object is returned per call (no site mutates or identity-compares it).
  const passthroughResult = () => ({
    segments: [],
    handles: "",
    routeName: matched.routeKey,
    params: matchedParams,
    passthrough: true as const,
  });

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
            return passthroughResult();
          }
          // Preserve vars set by getParams() for the render context
          if (hasContextVars(probeBuildVars)) {
            devProbeBuildVars = probeBuildVars;
          }
        } catch (err: any) {
          // Mirror production semantics (prerender-collection.ts):
          // Skip errors are intentional — treat as passthrough.
          // All other errors propagate so dev surfaces them.
          if (err?.name === "Skip") {
            return passthroughResult();
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
      _rotateStateCookie: () => {},
      _setKeepCacheDirective: () => {},
      use: (() => {
        throw new Error("use() not available during pre-rendering");
      }) as any,
      method: "GET",
      _handleStore: handleStore,
      _requestTags: new Set<string>(),
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
        // throwOnError: a render failure (or `throw new Skip()`) must reach the
        // build/dev caller, not be baked into a frozen error page (issue #587).
        { skipLoaders: true, throwOnError: true },
      );

      // 9. Detect passthrough sentinel: handler returned ctx.passthrough().
      // When the route declares loading(), the handler result is deferred so the
      // component is a thenable resolving to the sentinel — detectPrerenderPassthrough
      // resolves thenables before testing (a sync check would miss it and bake a
      // corrupt artifact).
      if (await detectPrerenderPassthrough(allSegments)) {
        return passthroughResult();
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
          // Resolve deferred values before encoding so the baked artifact holds
          // resolved data (prerender = build-time cache).
          handlesRecord[seg.id] = await resolveSegmentHandleValues(segHandles);
        }
      }
      const handles = await encodeHandles(handlesRecord);

      // Use the trie-level route key (e.g., "docs", "docs.article")
      const routeName = matched.routeKey;

      // Surface the matched route entry's ppr option for the build collection
      // (leaf-first: the deepest type:"route" entry in the ancestor chain is
      // the matched page route; ancestors are layouts/includes).
      let routePpr: boolean | PartialPrerenderProps | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (e.type === "route") {
          routePpr = e.ppr;
          break;
        }
      }

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
        // Flatten the entry and its sibling layouts into one source list, the
        // same traversal findInterceptForRoute uses; the build keeps ALL matches
        // (not just the innermost) and skips when(). intercept/layout are
        // non-optional arrays, so empty ones are a no-op here.
        for (const source of [current, ...current.layout]) {
          for (const ic of source.intercept) {
            if (ic.routeName === matched.routeKey) {
              foundIntercepts.push({ intercept: ic, entry: source });
            }
          }
        }
        current = current.parent;
      }

      if (foundIntercepts.length > 0) {
        const interceptResolvedSegments: typeof nonLoaderSegments = [];

        for (const { intercept, entry: parentEntry } of foundIntercepts) {
          // setupBuildUse keys handle pushes by ctx._currentSegmentId. The main
          // resolveAllSegments pass left it on the route's segment id, so pin it
          // to THIS intercept's slot id before resolving the handler/layout --
          // otherwise the intercept's ctx.use() handle pushes land in the wrong
          // bucket and getDataForSegment(seg.id) below drops them from the baked
          // artifact. Re-pinned per iteration so multiple intercepts targeting
          // the same route each get their own id (mirrors fresh.ts parallel-slot
          // pinning).
          const interceptSegmentId = `${parentEntry.shortCode}.${intercept.slotName}`;
          (buildCtx as InternalHandlerContext<any, TEnv>)._currentSegmentId =
            interceptSegmentId;

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
            id: interceptSegmentId,
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
              interceptHandlesRecord[seg.id] =
                await resolveSegmentHandleValues(segHandles);
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
        ppr: routePpr,
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
    _rotateStateCookie: () => {},
    _setKeepCacheDirective: () => {},
    use: (() => {
      throw new Error("use() not available during static pre-rendering");
    }) as any,
    method: "GET",
    _handleStore: handleStore,
    _requestTags: new Set<string>(),
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

    // Static handlers must return a ReactNode. A returned Response (e.g. an
    // accidental redirect()) would otherwise be serialized as a corrupt build
    // artifact; fail loudly instead. The fresh/revalidation paths route handler
    // results through handleHandlerResult, which throws Responses; the static
    // build path bypasses that, so guard here.
    if (raw instanceof Response) {
      throw new TypeError(
        `Static handler "${routeName}" returned a Response. Static handlers must return a ReactNode; ` +
          `Responses (redirects, file responses) are not supported during static pre-rendering.`,
      );
    }

    const segment: ResolvedSegment = {
      id: handlerId,
      namespace: handlerId,
      type: "layout",
      index: 0,
      component: raw,
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
        ? await encodeHandleValue(await resolveSegmentHandleValues(segHandles))
        : "";

    return { encoded: serialized.encoded, handles };
  });
}
