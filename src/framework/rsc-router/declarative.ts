import { RscRouter } from "./imperative";
import type {
  RouteMap,
  RouteDefinition,
  HandlerMap,
  RouteHandler,
  LayoutHandler,
  MiddlewareHandler,
} from "./types";
import { createDescriptors, type RouteDescriptors } from "./route-descriptor";

/**
 * Symbol exports for route metadata
 */
export const middleware = Symbol.for("route.middleware");
export const layout = Symbol.for("route.layout");
export const revalidate = Symbol.for("route.revalidate");
export const loading = Symbol.for("route.loading");
export const error = Symbol.for("route.error");

/**
 * Enhanced route map return type with descriptors
 */
export type RouteMapWithDescriptors<T extends RouteMap> = T & {
  $descriptors: RouteDescriptors<T>;
};

/**
 * Create a route map with type inference and route descriptors
 */
export function route<T extends RouteMap>(map: T): RouteMapWithDescriptors<T>;
export function route<T extends RouteMap, U extends RouteMap>(
  map1: T,
  map2: U
): RouteMapWithDescriptors<T & U>;
export function route(...maps: RouteMap[]): any {
  if (maps.length === 1) {
    const processed = processRouteMap(maps[0]);
    const descriptors = createDescriptors(processed);

    // Create a combined object with both the route map and descriptors
    return Object.assign(processed, {
      $descriptors: descriptors,
    });
  }

  // Merge multiple route maps
  const merged: RouteMap = {};
  for (const map of maps) {
    Object.assign(merged, processRouteMap(map));
  }

  const descriptors = createDescriptors(merged);
  return Object.assign(merged, {
    $descriptors: descriptors,
  });
}

/**
 * Process and validate a route map
 */
function processRouteMap(map: RouteMap, basePath: string = ""): RouteMap {
  const processed: RouteMap = {};

  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string") {
      // Simple string pattern
      const fullPath = joinPaths(basePath, value);
      processed[key] = fullPath;
    } else if (isRouteDefinition(value)) {
      // Route definition with method
      const fullPath = joinPaths(basePath, value.pattern);
      processed[key] = {
        ...value,
        pattern: fullPath,
      };
    } else if (isRouteMap(value)) {
      // Nested route map
      // For nested route maps, we just process them with the current base path
      // The patterns inside should be relative to the parent
      const nestedBasePath = key === "index" ? basePath : joinPaths(basePath, `/${key}`);

      // But wait - check if this looks like it's meant to be a route group
      // If all nested patterns start with the same segment that matches the key,
      // then don't add the key to the base path
      const nestedValues = Object.values(value);
      const firstPattern = typeof nestedValues[0] === 'string' ? nestedValues[0] :
        isRouteDefinition(nestedValues[0]) ? nestedValues[0].pattern : null;

      // If the first pattern starts with /category and the key is category,
      // then the patterns are absolute-ish and we shouldn't add the key
      const shouldAddKey = !firstPattern || !firstPattern.startsWith(`/${key}`);

      const actualBasePath = shouldAddKey ? nestedBasePath : basePath;
      processed[key] = processRouteMap(value, actualBasePath);
    }
  }

  return processed;
}

/**
 * Type guard for RouteDefinition
 */
function isRouteDefinition(value: any): value is RouteDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "pattern" in value &&
    typeof value.pattern === "string"
  );
}

/**
 * Type guard for RouteMap
 */
function isRouteMap(value: any): value is RouteMap {
  return (
    typeof value === "object" &&
    value !== null &&
    !isRouteDefinition(value) &&
    !Array.isArray(value)
  );
}

/**
 * Join path segments
 */
function joinPaths(...paths: string[]): string {
  return paths
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

/**
 * Router instance with declarative API
 */
export class DeclarativeRouter {
  private imperativeRouter: RscRouter;
  private routeMap: RouteMap = {};
  private handlers: Map<string, HandlerMap<any> | { __loader: () => Promise<{ default: HandlerMap<any> }> }> = new Map();
  private globalMiddleware: MiddlewareHandler[] = [];

  constructor(routes: RouteMap, options?: {
    [middleware]?: MiddlewareHandler[];
    [layout]?: LayoutHandler;
  }) {
    this.imperativeRouter = new RscRouter();
    this.routeMap = routes;

    // Apply global middleware if provided
    if (options?.[middleware]) {
      this.globalMiddleware = options[middleware];
    }

    // Apply global layout if provided
    if (options?.[layout]) {
      // This would wrap all routes - implementation depends on requirements
      console.warn("Global layout not yet implemented in declarative router");
    }
  }

  /**
   * Map route handlers to routes
   */
  map<T extends RouteMap>(
    routes: T,
    handlers: HandlerMap<T> | (() => Promise<{ default: HandlerMap<T> }>)
  ): this {
    if (typeof handlers === "function") {
      // Lazy loading - store the loader function
      this.handlers.set(JSON.stringify(routes), { __loader: handlers });
    } else {
      // Direct handlers
      console.log('[DeclarativeRouter] Mapping routes:', JSON.stringify(routes, null, 2));
      console.log('[DeclarativeRouter] Handlers keys:', Object.keys(handlers));
      this.registerHandlers(routes, handlers);
    }

    return this;
  }

  /**
   * Register handlers with the imperative router
   */
  private registerHandlers<T extends RouteMap>(
    routes: T,
    handlers: HandlerMap<T>,
    basePath: string = ""
  ) {
    // Extract metadata
    const middlewareHandlers = handlers[middleware] as MiddlewareHandler[] | undefined;
    const layoutHandler = handlers[layout] as LayoutHandler | undefined;
    // These will be implemented in future updates
    // const revalidateHandlers = handlers[revalidate] as any;
    // const loadingHandlers = handlers[loading] as any;
    // const errorHandler = handlers[error] as ErrorHandler | undefined;

    // Sort routes to ensure more specific routes are registered before dynamic ones
    // This prevents /blog/:slug from matching before /blog/category
    const sortedEntries = Object.entries(routes).sort(([keyA, valueA], [keyB, valueB]) => {
      // Skip metadata keys
      if (keyA.startsWith("_") || typeof keyA === "symbol") return 1;
      if (keyB.startsWith("_") || typeof keyB === "symbol") return -1;

      // Get patterns to compare
      const patternA = typeof valueA === "string" ? valueA :
        isRouteDefinition(valueA) ? valueA.pattern :
        isRouteMap(valueA) ? "nested" : "";

      const patternB = typeof valueB === "string" ? valueB :
        isRouteDefinition(valueB) ? valueB.pattern :
        isRouteMap(valueB) ? "nested" : "";

      // Nested routes (route maps) should be processed first
      if (patternA === "nested" && patternB !== "nested") return -1;
      if (patternB === "nested" && patternA !== "nested") return 1;

      // Static segments before dynamic segments
      const isDynamicA = patternA.includes(":");
      const isDynamicB = patternB.includes(":");

      if (!isDynamicA && isDynamicB) return -1;
      if (!isDynamicB && isDynamicA) return 1;

      // Otherwise maintain original order
      return 0;
    });

    // Process each route
    for (const [key, routeValue] of sortedEntries) {
      if (key.startsWith("_") || typeof key === "symbol") {
        continue; // Skip metadata keys
      }

      const handlerValue = handlers[key];

      if (typeof routeValue === "string") {
        // Simple route
        const pattern = joinPaths(basePath, routeValue);

        if (typeof handlerValue === "function") {
          // Register with imperative router
          const allHandlers = [
            ...(this.globalMiddleware || []),
            ...(middlewareHandlers || []),
            handlerValue as RouteHandler,
          ];

          if (layoutHandler) {
            this.imperativeRouter.layout(pattern, layoutHandler);
          }

          this.imperativeRouter.get(pattern, ...allHandlers);

          if (layoutHandler) {
            this.imperativeRouter.endLayout();
          }
        }
      } else if (isRouteDefinition(routeValue)) {
        // Route with method
        const pattern = joinPaths(basePath, routeValue.pattern);
        const method = routeValue.method || "GET";

        if (typeof handlerValue === "function") {
          const allHandlers = [
            ...(this.globalMiddleware || []),
            ...(middlewareHandlers || []),
            handlerValue as RouteHandler,
          ];

          if (layoutHandler) {
            this.imperativeRouter.layout(pattern, layoutHandler);
          }

          // Register based on method
          switch (method) {
            case "GET":
              this.imperativeRouter.get(pattern, ...allHandlers);
              break;
            case "POST":
              this.imperativeRouter.post(pattern, ...allHandlers);
              break;
            case "ALL":
              this.imperativeRouter.all(pattern, ...allHandlers);
              break;
            default:
              console.warn(`Method ${method} not yet supported`);
          }

          if (layoutHandler) {
            this.imperativeRouter.endLayout();
          }
        }
      } else if (isRouteMap(routeValue)) {
        // Nested routes - routes already have full paths from processRouteMap
        // Don't add basePath again, just pass empty string
        if (isRouteMap(handlerValue)) {
          // Apply parent layout if exists
          if (layoutHandler) {
            // For layout, we need the base path of this route group
            const layoutPath = key === "index" ? basePath : joinPaths(basePath, `/${key}`);
            this.imperativeRouter.layout(layoutPath, layoutHandler);
          }

          this.registerHandlers(
            routeValue,
            handlerValue as HandlerMap<typeof routeValue>,
            "" // Routes already have full paths, don't add base path
          );

          if (layoutHandler) {
            this.imperativeRouter.endLayout();
          }
        }
      }
    }
  }

  /**
   * Match a request (delegates to imperative router)
   */
  async match(request: Request) {
    // Load lazy handlers if needed
    for (const [key, value] of this.handlers.entries()) {
      if (value && typeof value === 'object' && "__loader" in value) {
        const loader = value as { __loader: () => Promise<{ default: HandlerMap<any> }> };
        const module = await loader.__loader();
        const routes = JSON.parse(key);
        this.registerHandlers(routes, module.default);
        this.handlers.set(key, module.default);
      }
    }

    return this.imperativeRouter.match(request);
  }

  /**
   * Match partial for client-side navigation
   */
  async matchPartial(request: Request, previousPathname?: string | null) {
    // Load lazy handlers if needed
    for (const [key, value] of this.handlers.entries()) {
      if (value && typeof value === 'object' && "__loader" in value) {
        const loader = value as { __loader: () => Promise<{ default: HandlerMap<any> }> };
        const module = await loader.__loader();
        const routes = JSON.parse(key);
        this.registerHandlers(routes, module.default);
        this.handlers.set(key, module.default);
      }
    }

    return this.imperativeRouter.matchPartial(request, previousPathname);
  }
}

/**
 * Create a new router instance with declarative API
 */
export function createRouter<T extends RouteMap>(
  routes: T,
  options?: {
    [middleware]?: MiddlewareHandler[];
    [layout]?: LayoutHandler;
  }
): DeclarativeRouter {
  return new DeclarativeRouter(routes, options);
}