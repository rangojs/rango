/**
 * Route definition utilities
 * Creates typed route maps for the RSC Router
 */

/**
 * A route definition can be either:
 * - A string path (e.g., '/', '/about', '/users/:id') - Phase 1.1
 * - A nested object of route definitions - Phase 1.2 (not yet implemented)
 *
 * For now (Phase 1.1), only string paths are supported
 */
export type RouteDefinition = string;

/**
 * Route class that wraps route definitions
 * This allows the router to identify route maps and provide additional functionality
 *
 * @template T - The route definitions object type
 */
export class RouteMap<T extends Record<string, RouteDefinition>> {
  /**
   * Internal storage for route definitions
   * @internal
   */
  private readonly _routes: T;

  /**
   * @internal - Use route() function instead
   */
  constructor(definitions: T) {
    this._routes = definitions;

    // Make route definitions accessible as properties
    // This allows: routeMap.home instead of routeMap.get('home')
    Object.keys(definitions).forEach((key) => {
      Object.defineProperty(this, key, {
        get() {
          return definitions[key];
        },
        enumerable: true,
        configurable: false,
      });
    });
  }

  /**
   * Get a route path by name
   * @param name - Route name
   * @returns Route path pattern
   */
  get<K extends keyof T>(name: K): T[K] {
    return this._routes[name];
  }

  /**
   * Get all route definitions
   * @returns All route definitions
   */
  getAll(): T {
    return { ...this._routes };
  }

  /**
   * Get all route names
   * @returns Array of route names
   */
  getRouteNames(): Array<keyof T> {
    return Object.keys(this._routes) as Array<keyof T>;
  }

  /**
   * Check if a route name exists
   * @param name - Route name to check
   * @returns True if route exists
   */
  has(name: keyof T): boolean {
    return name in this._routes;
  }

  /**
   * @internal - Used by router for iteration
   */
  entries(): Array<[keyof T, T[keyof T]]> {
    return Object.entries(this._routes) as Array<[keyof T, T[keyof T]]>;
  }
}

/**
 * Creates a typed route map from route definitions
 *
 * @param definitions - Object mapping route names to path patterns
 * @returns RouteMap instance with full type safety and property access
 *
 * @example
 * ```typescript
 * const routes = route({
 *   home: '/',
 *   about: '/about',
 *   user: '/users/:id'
 * });
 *
 * routes.home // '/' - property access
 * routes.get('home') // '/' - method access
 * routes.getRouteNames() // ['home', 'about', 'user']
 * ```
 */
export function route<const T extends Record<string, RouteDefinition>>(
  definitions: T
): InstanceType<typeof RouteMap<T>> & T {
  return new RouteMap(definitions) as InstanceType<typeof RouteMap<T>> & T;
}
