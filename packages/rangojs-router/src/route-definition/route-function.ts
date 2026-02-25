import type {
  ResolvedRouteMap,
  RouteConfig,
  RouteDefinition,
  RouteDefinitionOptions,
  TrailingSlashMode,
} from "../types.js";

/**
 * Result of route() function with paths and trailing slash config
 */
export interface RouteDefinitionResult<T extends RouteDefinition> {
  routes: ResolvedRouteMap<T>;
  trailingSlash: Record<string, TrailingSlashMode>;
}

/**
 * Check if a value is a RouteConfig object
 */
function isRouteConfig(value: unknown): value is RouteConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof (value as RouteConfig).path === "string"
  );
}

/**
 * Define routes with optional trailing slash configuration
 *
 * @example
 * ```typescript
 * // Simple string paths
 * const routes = route({
 *   blog: "/blog",
 *   post: "/blog/:id",
 * });
 *
 * // With trailing slash config
 * const routes = route({
 *   blog: "/blog",
 *   api: { path: "/api", trailingSlash: "ignore" },
 * }, { trailingSlash: "never" }); // global default
 * ```
 */
export function route<const T extends RouteDefinition>(
  input: T,
  options?: RouteDefinitionOptions,
): ResolvedRouteMap<T> & {
  __trailingSlash?: Record<string, TrailingSlashMode>;
} {
  const trailingSlash: Record<string, TrailingSlashMode> = {};
  const routes = flattenRoutes(
    input as RouteDefinition,
    "",
    trailingSlash,
    options?.trailingSlash,
  );

  // Attach trailing slash config as a non-enumerable property
  // This keeps backwards compatibility while passing the config through
  const result = routes as ResolvedRouteMap<T> & {
    __trailingSlash?: Record<string, TrailingSlashMode>;
  };
  if (Object.keys(trailingSlash).length > 0) {
    Object.defineProperty(result, "__trailingSlash", {
      value: trailingSlash,
      enumerable: false,
      writable: false,
    });
  }

  return result;
}

/**
 * Flatten nested route definitions
 */
function flattenRoutes(
  routes: RouteDefinition,
  prefix: string,
  trailingSlashConfig: Record<string, TrailingSlashMode>,
  defaultTrailingSlash?: TrailingSlashMode,
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(routes)) {
    const fullKey = prefix + key;

    if (typeof value === "string") {
      // Direct route pattern - include prefix
      flattened[fullKey] = value;
      // Apply default trailing slash if set
      if (defaultTrailingSlash) {
        trailingSlashConfig[fullKey] = defaultTrailingSlash;
      }
    } else if (isRouteConfig(value)) {
      // Route config object with path and optional trailingSlash
      flattened[fullKey] = value.path;
      // Use route-specific config or fall back to default
      const mode = value.trailingSlash ?? defaultTrailingSlash;
      if (mode) {
        trailingSlashConfig[fullKey] = mode;
      }
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(
        value,
        `${fullKey}.`,
        trailingSlashConfig,
        defaultTrailingSlash,
      );
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}
