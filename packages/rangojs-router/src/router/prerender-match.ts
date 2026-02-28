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
} from "./handler-context.js";
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
): Promise<{
  segments: SerializedSegmentData[];
  handles: Record<string, SegmentHandleData>;
  routeName: string;
  params: Record<string, string>;
  interceptSegments?: SerializedSegmentData[];
  interceptHandles?: Record<string, SegmentHandleData>;
} | null> {
  // 1. Find the matching route entry
  const matched = deps.findMatch(pathname);
  if (!matched) return null;

  // Use params from trie match if available, fall back to provided params
  const matchedParams = matched.params ?? params;

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

    // 4. Create handle store for collecting handle data
    const handleStore = createHandleStore();

    // 5. Create a minimal request context with the handle store
    // Shallow-copy getParams vars so each param set is independent
    const variables: Record<string, any> = buildVars ? { ...buildVars } : {};
    const stubRes = new Response(null, { status: 200 });
    const minimalRequestContext: RequestContext<TEnv> = {
      env: {} as TEnv,
      request: new Request("http://prerender" + pathname),
      url: new URL("http://prerender" + pathname),
      pathname,
      searchParams: new URLSearchParams(),
      var: variables,
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
    };

    return runWithRequestContext(minimalRequestContext, async () => {
      // 6. Create prerender context with synthetic URL.
      // Prerender handlers get params, pathname, url, searchParams, search,
      // reverse, and use(handle) — but no request, env, headers, or cookies.
      const buildCtx = createPrerenderContext<TEnv>(
        matchedParams,
        pathname,
        deps.mergedRouteMap,
        matched.routeKey,
        variables,
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

      // 9. Filter out any loader segments (belt-and-suspenders)
      const nonLoaderSegments = allSegments.filter((s) => s.type !== "loader");

      // 10. Wait for handles to settle
      await handleStore.settled;

      // 11. Serialize segments using the cache serializer
      const { serializeSegments } = await import("../cache/segment-codec.js");
      const serializedSegments = await serializeSegments(nonLoaderSegments);

      // 12. Collect handle data per segment (skip segments with no handle data)
      const handles: Record<string, SegmentHandleData> = {};
      for (const seg of nonLoaderSegments) {
        const segHandles = handleStore.getDataForSegment(seg.id);
        if (Object.keys(segHandles).length > 0) {
          handles[seg.id] = segHandles;
        }
      }

      // Use the trie-level route key (e.g., "docs", "docs.article")
      const routeName = matched.routeKey;

      // 13. Resolve intercept segments for this route (if any ancestor defines
      //     an intercept targeting this route). At build time we skip when()
      //     evaluation -- we pre-render all intercepts unconditionally and let
      //     runtime matching decide which to serve.
      let interceptSegments: SerializedSegmentData[] | undefined;
      let interceptHandles: Record<string, SegmentHandleData> | undefined;

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
          interceptHandles = {};
          for (const seg of interceptResolvedSegments) {
            const segHandles = handleStore.getDataForSegment(seg.id);
            if (Object.keys(segHandles).length > 0) {
              interceptHandles[seg.id] = segHandles;
            }
          }
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
): Promise<{ encoded: string; handles: Record<string, unknown[]> } | null> {
  const syntheticUrl = new URL("http://prerender/");
  const syntheticRequest = new Request(syntheticUrl);

  // Create a HandleStore to capture handle data pushed during rendering
  const handleStore = createHandleStore();

  // Minimal request context so setupBuildUse can find the HandleStore
  const stubRes = new Response(null, { status: 200 });
  const minimalRequestContext: RequestContext<TEnv> = {
    env: {} as TEnv,
    request: syntheticRequest,
    url: syntheticUrl,
    pathname: "/",
    searchParams: syntheticUrl.searchParams,
    var: {},
    get: () => undefined as any,
    set: () => {},
    params: {},
    res: stubRes,
    cookie: () => undefined,
    cookies: () => ({}),
    setCookie: () => {},
    deleteCookie: () => {},
    header: () => {},
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
  };

  return runWithRequestContext(minimalRequestContext, async () => {
    // Static handlers get only reverse and use(handle) — no URL, params,
    // request, env, headers, or cookies.
    const buildCtx = createStaticContext<TEnv>(mergedRouteMap, routeName);

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
    const [serialized] = await serializeSegments([segment]);

    // Collect handle data pushed during rendering
    const handles = handleStore.getDataForSegment(handlerId);

    return { encoded: serialized.encoded, handles };
  });
}
