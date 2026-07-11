import type { ReactNode } from "react";
import type { Handler } from "../types.js";
import type { RouteItem, RouteUseItem, UseItems } from "../route-types.js";
import {
  getUrlPrefix,
  getNamePrefix,
  getRootScoped,
  requireDslContext,
  stampStaticDefScope,
} from "../server/context";
import { invariant, DataNotFoundError } from "../errors";
import { validateUserRouteName } from "../route-name.js";
import {
  isPrerenderHandler,
  isPassthroughHandler,
  type PrerenderHandlerDefinition,
} from "../prerender.js";
import {
  isStaticHandler,
  type StaticHandlerDefinition,
} from "../static-handler.js";
import {
  registerSearchSchema,
  registerRouteRootScope,
} from "../route-map-builder.js";
import { RESPONSE_TYPE } from "./response-types.js";
import type { PathOptions } from "./pattern-types.js";
import type {
  PathFn,
  ResponsePathFn,
  JsonResponsePathFn,
  TextResponsePathFn,
} from "./path-helper-types.js";
import {
  resolveHandlerUse,
  mergeHandlerUse,
} from "../route-definition/resolve-handler-use.js";
import {
  emptySegmentBase,
  runAndValidateUseItems,
} from "../route-definition/dsl-helpers.js";

function applyUrlPrefix(prefix: string, pattern: string): string {
  if (!prefix) return pattern;
  if (pattern === "/") return prefix;
  if (prefix.endsWith("/") && pattern.startsWith("/")) {
    return prefix + pattern.slice(1);
  }
  return prefix + pattern;
}

function applyNamePrefix(prefix: string | undefined, name: string): string {
  if (!prefix) return name;
  return `${prefix}.${name}`;
}

function resolveResponseType(
  options: PathOptions | undefined,
): string | undefined {
  return options?.[RESPONSE_TYPE];
}

export function createPathHelper<TEnv>(): PathFn<TEnv> {
  return ((
    pattern: string,
    handler: ReactNode | Handler<any, any, TEnv>,
    optionsOrUse?: PathOptions | (() => UseItems<RouteUseItem>),
    maybeUse?: () => UseItems<RouteUseItem>,
  ): RouteItem => {
    const { store, ctx } = requireDslContext(
      "path() must be called inside urls()",
    );

    invariant(
      !ctx.parent || ctx.parent.type !== "parallel",
      "path() cannot be used inside parallel()",
    );

    {
      let ancestor = ctx.parent;
      while (ancestor) {
        invariant(
          ancestor.type !== "route",
          "path() cannot be nested inside another path()",
        );
        ancestor = ancestor.parent;
      }
    }

    let options: PathOptions | undefined;
    let use: (() => UseItems<RouteUseItem>) | undefined;

    if (typeof optionsOrUse === "function") {
      // path(pattern, handler, use)
      use = optionsOrUse as () => UseItems<RouteUseItem>;
    } else if (typeof optionsOrUse === "object") {
      // path(pattern, handler, options) or path(pattern, handler, options, use)
      options = optionsOrUse as PathOptions;
      use = maybeUse;
    }

    const handlerUseFn = resolveHandlerUse(handler);
    const mountSite = resolveResponseType(options) ? "response" : "path";
    const mergedUse = mergeHandlerUse(handlerUseFn, use, mountSite);

    const urlPrefix = getUrlPrefix();
    const namePrefix = getNamePrefix();

    const prefixedPattern = applyUrlPrefix(urlPrefix, pattern);

    const localName =
      options?.name || `$path_${pattern.replace(/[/:*?]/g, "_")}`;
    if (options?.name) {
      validateUserRouteName(options.name);
    }
    const routeName = applyNamePrefix(namePrefix, localName);

    const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${routeName}`;

    if (ctx.forRoute && routeName !== ctx.forRoute) {
      store.getShortCode("route");
      return { type: "route" } as RouteItem;
    }

    const wrappedHandler: Handler<any, any, TEnv> =
      typeof handler === "function"
        ? (handler as Handler<any, any, TEnv>)
        : isPassthroughHandler(handler)
          ? typeof handler.prerenderDef.handler === "function"
            ? (handler.prerenderDef.handler as Handler<any, any, TEnv>)
            : () => {
                throw new DataNotFoundError(
                  "No prerender data found for this route",
                );
              }
          : isPrerenderHandler(handler)
            ? typeof handler.handler === "function"
              ? (handler.handler as Handler<any, any, TEnv>)
              : () => {
                  throw new DataNotFoundError(
                    "No prerender data found for this route",
                  );
                }
            : isStaticHandler(handler)
              ? (handler.handler as Handler<any, any, TEnv>)
              : () => handler;

    // On-demand opt-in lives on the (inner) Prerender def's options for both
    // plain Prerender and Passthrough-wrapped routes. Presence (truthy, not
    // false) marks the route ISR-eligible; the trie od flag + producer retention
    // key off it.
    const onDemandDef = isPassthroughHandler(handler)
      ? handler.prerenderDef
      : isPrerenderHandler(handler)
        ? handler
        : undefined;
    const onDemandOpt = onDemandDef?.options?.onDemand;
    const isOnDemand = onDemandOpt != null && onDemandOpt !== false;

    const entry = {
      ...emptySegmentBase(),
      id: namespace,
      shortCode: store.getShortCode("route"),
      type: "route" as const,
      parent: ctx.parent,
      handler: wrappedHandler,
      pattern: prefixedPattern,
      ...(urlPrefix ? { mountPath: urlPrefix } : {}),
      ...(isPassthroughHandler(handler)
        ? {
            isPrerender: true as const,
            prerenderDef: handler.prerenderDef as PrerenderHandlerDefinition,
            isPassthrough: true as const,
            liveHandler: handler.liveHandler as Handler<any, any, TEnv>,
          }
        : isPrerenderHandler(handler)
          ? {
              isPrerender: true as const,
              prerenderDef: handler as PrerenderHandlerDefinition,
            }
          : {}),
      ...(isOnDemand ? { isOnDemand: true as const } : {}),
      ...(isStaticHandler(handler)
        ? {
            isStaticPrerender: true as const,
            ...(handler.$$id ? { staticHandlerId: handler.$$id } : {}),
          }
        : {}),
      ...(resolveResponseType(options)
        ? { responseType: resolveResponseType(options) }
        : {}),
      // PPR shell-caching opt-in (document-level). Stored raw; the integrated
      // serve path normalizes it via resolvePprConfig (rsc/shell-serve.ts).
      ...(options?.ppr !== undefined && options.ppr !== false
        ? { ppr: options.ppr }
        : {}),
    };

    if (isStaticHandler(handler) && handler.$$id) {
      if (ctx.namePrefix) {
        (handler as any).$$routePrefix = ctx.namePrefix;
      }
      stampStaticDefScope(handler, routeName);
    }

    invariant(
      ctx.manifest.get(routeName) === undefined,
      `Duplicate route name: ${routeName} at ${namespace}`,
    );

    ctx.manifest.set(routeName, entry);

    registerRouteRootScope(routeName, getRootScoped(), ctx.routerId);

    if (ctx.patterns) {
      ctx.patterns.set(routeName, prefixedPattern);
    }

    if (ctx.patternsByPrefix) {
      const urlPrefix = getUrlPrefix() || "";
      if (!ctx.patternsByPrefix.has(urlPrefix)) {
        ctx.patternsByPrefix.set(urlPrefix, new Map());
      }
      ctx.patternsByPrefix.get(urlPrefix)!.set(routeName, prefixedPattern);
    }

    if (options?.trailingSlash && ctx.trailingSlash) {
      ctx.trailingSlash.set(routeName, options.trailingSlash);
    }

    if (options?.search) {
      if (ctx.searchSchemas) {
        ctx.searchSchemas.set(routeName, options.search);
      }
      registerSearchSchema(routeName, options.search, ctx.routerId);
    }

    if (mergedUse) {
      const result = runAndValidateUseItems(
        store,
        namespace,
        entry,
        mergedUse,
        "path",
        "use",
      );
      return { name: namespace, type: "route", uses: result } as RouteItem;
    }

    return { name: namespace, type: "route" } as RouteItem;
  }) as PathFn<TEnv>;
}

export function attachPathResponseTags<TEnv>(
  pathFn: PathFn<TEnv>,
): PathFn<TEnv> & {
  json: JsonResponsePathFn<TEnv>;
  text: TextResponsePathFn<TEnv>;
  html: TextResponsePathFn<TEnv>;
  xml: TextResponsePathFn<TEnv>;
  md: TextResponsePathFn<TEnv>;
  image: ResponsePathFn<TEnv>;
  stream: ResponsePathFn<TEnv>;
  any: ResponsePathFn<TEnv>;
} {
  function createTagged(responseType: string): ResponsePathFn<TEnv> {
    return ((
      pattern: string,
      handler: any,
      optionsOrUse?: any,
      maybeUse?: any,
    ) => {
      let options: PathOptions;
      let use: (() => any[]) | undefined;
      if (typeof optionsOrUse === "function") {
        options = { [RESPONSE_TYPE]: responseType };
        use = optionsOrUse;
      } else {
        options = { ...optionsOrUse, [RESPONSE_TYPE]: responseType };
        use = maybeUse;
      }

      return pathFn(pattern, handler, options, use);
    }) as ResponsePathFn<TEnv>;
  }

  const extended = pathFn as any;
  extended.json = createTagged("json");
  extended.text = createTagged("text");
  extended.html = createTagged("html");
  extended.xml = createTagged("xml");
  extended.md = createTagged("md");
  extended.image = createTagged("image");
  extended.stream = createTagged("stream");
  extended.any = createTagged("any");
  return extended;
}
