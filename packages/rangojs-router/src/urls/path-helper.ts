import type { ReactNode } from "react";
import type { Handler } from "../types.js";
import type { RouteItem, RouteUseItem, UseItems } from "../route-types.js";
import {
  getUrlPrefix,
  getNamePrefix,
  getRootScoped,
  requireDslContext,
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

/**
 * Apply URL prefix to a pattern
 * Handles edge cases like "/" patterns and double slashes
 */
function applyUrlPrefix(prefix: string, pattern: string): string {
  if (!prefix) return pattern;
  if (pattern === "/") return prefix;
  if (prefix.endsWith("/") && pattern.startsWith("/")) {
    return prefix + pattern.slice(1);
  }
  return prefix + pattern;
}

/**
 * Apply name prefix to a route name
 */
function applyNamePrefix(prefix: string | undefined, name: string): string {
  if (!prefix) return name;
  return `${prefix}.${name}`;
}

/**
 * Resolve response type from path options (set by path.json(), path.text(), etc.)
 */
function resolveResponseType(
  options: PathOptions | undefined,
): string | undefined {
  return options?.[RESPONSE_TYPE];
}

/**
 * Create path() helper
 *
 * The path() function is the key new feature - it combines URL pattern
 * with handler at the definition site.
 */
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

    // Walk the parent chain to prevent path() nested under another path(),
    // even when separated by intermediate layouts (e.g. path(layout(path())))
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

    // Determine options and use based on argument types
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

    // Merge handler.use() defaults with explicit use()
    // Response routes (path.json, path.text, etc.) only allow middleware + cache
    const handlerUseFn = resolveHandlerUse(handler);
    const mountSite = resolveResponseType(options) ? "response" : "path";
    const mergedUse = mergeHandlerUse(handlerUseFn, use, mountSite);

    // Get prefixes from context (set by include())
    const urlPrefix = getUrlPrefix();
    const namePrefix = getNamePrefix();

    // Apply URL prefix to pattern
    const prefixedPattern = applyUrlPrefix(urlPrefix, pattern);

    // Generate route name - use provided name or generate from pattern
    const localName =
      options?.name || `$path_${pattern.replace(/[/:*?]/g, "_")}`;
    if (options?.name) {
      validateUserRouteName(options.name);
    }
    // Apply name prefix if set (from include())
    const routeName = applyNamePrefix(namePrefix, localName);

    const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${routeName}`;

    // Per-request pruning: skip registration for routes that won't be rendered.
    // forRoute is set by loadManifest() to the matched route name. During
    // evaluateLazyEntry() (route matching), forRoute is unset so all routes
    // register normally. We still increment counters to keep shortCodes stable
    // across different routes (needed for segment reconciliation on navigation).
    //
    // include() does not need its own forRoute pruning. include() creates lazy
    // entries that defer handler execution until route matching. When the lazy
    // handler eventually runs inside loadManifest(), this path() check already
    // covers all routes defined inside the include.
    if (ctx.forRoute && routeName !== ctx.forRoute) {
      store.getShortCode("route");
      return { type: "route" } as RouteItem;
    }

    // Ensure handler is always a function (wrap ReactNode or extract from prerender/static def)
    // For prerender stubs (production builds where handler code is evicted),
    // handler.handler is undefined — provide a notFound fallback so requests
    // for non-prerendered params get 404 instead of "handler is not a function".
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

    const entry = {
      ...emptySegmentBase(),
      id: namespace,
      shortCode: store.getShortCode("route"),
      type: "route" as const,
      parent: ctx.parent,
      handler: wrappedHandler,
      // Store the PREFIXED pattern for route matching
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
      ...(isStaticHandler(handler)
        ? {
            isStaticPrerender: true as const,
            ...(handler.$$id ? { staticHandlerId: handler.$$id } : {}),
          }
        : {}),
      ...(resolveResponseType(options)
        ? { responseType: resolveResponseType(options) }
        : {}),
    };

    // Capture namespace prefix on static handler for build-time reverse() resolution
    if (isStaticHandler(handler) && handler.$$id && ctx.namePrefix) {
      (handler as any).$$routePrefix = ctx.namePrefix;
    }

    // Check for duplicate route names (TypeScript should catch this, but runtime check too)
    invariant(
      ctx.manifest.get(routeName) === undefined,
      `Duplicate route name: ${routeName} at ${namespace}`,
    );

    // Register route entry with prefixed name
    ctx.manifest.set(routeName, entry);

    // Register root-scope flag for dot-local reverse resolution
    registerRouteRootScope(routeName, getRootScoped());

    // Also store pattern in a separate map for URL generation
    if (ctx.patterns) {
      ctx.patterns.set(routeName, prefixedPattern);
    }

    // Store pattern grouped by URL prefix for separate entry creation
    if (ctx.patternsByPrefix) {
      const urlPrefix = getUrlPrefix() || "";
      if (!ctx.patternsByPrefix.has(urlPrefix)) {
        ctx.patternsByPrefix.set(urlPrefix, new Map());
      }
      ctx.patternsByPrefix.get(urlPrefix)!.set(routeName, prefixedPattern);
    }

    // Store trailing slash config if specified
    if (options?.trailingSlash && ctx.trailingSlash) {
      ctx.trailingSlash.set(routeName, options.trailingSlash);
    }

    // Store search schema if specified
    if (options?.search) {
      if (ctx.searchSchemas) {
        ctx.searchSchemas.set(routeName, options.search);
      }
      registerSearchSchema(routeName, options.search);
    }

    // Run merged use callback (handler.use defaults + explicit use) if present
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

/**
 * Attach response type tag methods (.json, .text, .html, .xml, .md, .image, .stream, .any) to a path helper.
 * Each tag wraps the original path() call with the RESPONSE_TYPE option set.
 */
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
