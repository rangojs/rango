import type { RouteMap, RouteDefinition, ExtractRouteParams } from "./types";
import { buildPath } from "./route-paths";

/**
 * Route descriptor object that provides type-safe route information
 * and path building capabilities
 *
 * @example
 * const descriptor: RouteDescriptor<"/items/:id"> = {
 *   pattern: "/items/:id",
 *   params: {} as { id: string },
 *   build: (params) => `/items/${params.id}`
 * }
 */
export interface RouteDescriptor<
  TPattern extends string = string,
  TParams extends Record<string, string> = ExtractRouteParams<TPattern>
> {
  /** The route pattern with parameter placeholders */
  pattern: TPattern;
  /** Type-safe parameter object (for type inference only) */
  params: TParams;
  /** Build a path from this route with the given parameters */
  build(params: TParams): string;
}

/**
 * Convert RouteMap to RouteDescriptors
 * Recursively transforms route definitions into descriptor objects
 *
 * @example
 * type Descriptors = RouteDescriptors<{
 *   home: "/",
 *   items: { detail: "/items/:id" }
 * }>
 * // Result: {
 * //   home: RouteDescriptor<"/">
 * //   items: { detail: RouteDescriptor<"/items/:id"> }
 * // }
 */
export type RouteDescriptors<T> = T extends string
  ? RouteDescriptor<T, ExtractRouteParams<T>>
  : T extends RouteDefinition
  ? RouteDescriptor<T["pattern"], ExtractRouteParams<T["pattern"]>>
  : T extends RouteMap
  ? { [K in keyof T]: RouteDescriptors<T[K]> }
  : never;

/**
 * Check if value is a RouteMap (nested object)
 */
function isRouteMap(value: any): value is RouteMap {
  return (
    typeof value === "object" &&
    value !== null &&
    !("pattern" in value) &&
    !("method" in value)
  );
}

/**
 * Check if value is a RouteDefinition
 */
function isRouteDefinition(value: any): value is RouteDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.pattern === "string"
  );
}

/**
 * Join path segments, handling leading/trailing slashes
 */
function joinPaths(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');

  if (!normalizedBase || normalizedBase === '/') {
    return '/' + normalizedPath;
  }

  return normalizedBase + '/' + normalizedPath;
}

/**
 * Create route descriptors from a RouteMap
 * This is the runtime implementation that creates descriptor objects
 *
 * @param map - The route map to convert
 * @param basePath - The base path for nested routes
 * @returns RouteDescriptors object with build functions
 */
export function createDescriptors<T extends RouteMap>(
  map: T,
  basePath = ""
): RouteDescriptors<T> {
  const descriptors: any = {};

  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string") {
      // Simple string route: "/path"
      const fullPath = value.startsWith('/') ? value : joinPaths(basePath, value);
      descriptors[key] = {
        pattern: fullPath,
        params: {} as ExtractRouteParams<typeof fullPath>,
        build: (params: any) => buildPath(fullPath, params),
      };
    } else if (isRouteDefinition(value)) {
      // RouteDefinition: { pattern: "/path", method: "GET" }
      const fullPath = value.pattern.startsWith('/')
        ? value.pattern
        : joinPaths(basePath, value.pattern);
      descriptors[key] = {
        pattern: fullPath,
        params: {} as ExtractRouteParams<typeof fullPath>,
        build: (params: any) => buildPath(fullPath, params),
      };
    } else if (isRouteMap(value)) {
      // Nested RouteMap: recurse with updated base path
      // For nested routes, we don't automatically add the key to the path
      // unless the nested routes are relative
      descriptors[key] = createDescriptors(value, basePath);
    }
  }

  return descriptors as RouteDescriptors<T>;
}
