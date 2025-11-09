/**
 * Route definition utilities
 * Creates typed route maps for the RSC Router
 */

/**
 * A route definition can be either:
 * - A string path (e.g., '/', '/about', '/users/:id')
 * - A nested object of route definitions (for grouped routes)
 */
export type RouteDefinition =
  | string
  | { [key: string]: RouteDefinition };

/**
 * Recursively maps route definitions to their resolved types
 * - String → string
 * - Nested object → ResolvedRouteMap<T>
 */
export type RouteMapType<T> = T extends string
  ? string
  : T extends Record<string, RouteDefinition>
    ? ResolvedRouteMap<T>
    : never;

/**
 * Resolved route map type that includes both class methods and properties
 * This type tells TypeScript that RouteMap<T> has all properties from T
 */
export type ResolvedRouteMap<T extends Record<string, RouteDefinition>> =
  RouteMap<T> & {
    [K in keyof T]: RouteMapType<T[K]>;
  };

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

    // Process each definition - could be string or nested object
    Object.keys(definitions).forEach((key) => {
      const value = definitions[key];

      if (typeof value === 'string') {
        // Simple string path - create getter
        Object.defineProperty(this, key, {
          get() {
            return value;
          },
          enumerable: true,
          configurable: false,
        });
      } else {
        // Nested object - recursively create RouteMap
        Object.defineProperty(this, key, {
          get() {
            return new RouteMap(value as Record<string, RouteDefinition>);
          },
          enumerable: true,
          configurable: false,
        });
      }
    });
  }

  /**
   * Get a route path by name (or nested RouteMap)
   * @param name - Route name
   * @returns Route path pattern or nested RouteMap
   */
  get<K extends keyof T>(name: K): RouteMapType<T[K]> {
    const value = this._routes[name];

    if (typeof value === 'string') {
      return value as unknown as RouteMapType<T[K]>;
    } else {
      return new RouteMap(
        value as Record<string, RouteDefinition>
      ) as unknown as RouteMapType<T[K]>;
    }
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
  has(name: string): boolean {
    return name in this._routes;
  }

  /**
   * @internal - Used by router for iteration
   */
  entries(): Array<[keyof T, T[keyof T]]> {
    return Object.entries(this._routes) as Array<[keyof T, T[keyof T]]>;
  }

  /**
   * Check if this RouteMap represents nested routes
   * @returns True if any definition is an object (nested)
   */
  isNested(): boolean {
    return Object.values(this._routes).some(
      (value) => typeof value === 'object'
    );
  }

  /**
   * Get all leaf paths (flattened)
   * Useful for getting all actual route paths from nested structure
   * @returns Array of all path strings
   */
  getAllPaths(): string[] {
    const paths: string[] = [];

    for (const value of Object.values(this._routes)) {
      if (typeof value === 'string') {
        paths.push(value);
      } else {
        // Recursively get paths from nested RouteMap
        const nestedMap = new RouteMap(value as Record<string, RouteDefinition>);
        paths.push(...nestedMap.getAllPaths());
      }
    }

    return paths;
  }
}

/**
 * Special symbols for route metadata
 * These are used as keys in route handler objects to define special properties
 */

/**
 * Symbol for defining layouts
 * @example
 * ```typescript
 * {
 *   [route.layout]: MyLayout,
 *   index: () => <Content />
 * }
 * ```
 */
const layoutSymbol = Symbol('route.layout');

/**
 * Symbol for defining parallel routes (named slots)
 * @example
 * ```typescript
 * {
 *   [route.parallel]: {
 *     '@sidebar': SidebarComponent,
 *     '@modal': ModalComponent
 *   }
 * }
 * ```
 */
const parallelSymbol = Symbol('route.parallel');

/**
 * Symbol for defining loading boundaries
 * @example
 * ```typescript
 * {
 *   [route.loading]: LoadingComponent,
 *   index: () => <Content />
 * }
 * ```
 */
const loadingSymbol = Symbol('route.loading');

/**
 * Symbol for defining error boundaries
 * @example
 * ```typescript
 * {
 *   [route.error]: ErrorComponent,
 *   index: () => <Content />
 * }
 * ```
 */
const errorSymbol = Symbol('route.error');

/**
 * Symbol for defining revalidation logic
 * @example
 * ```typescript
 * {
 *   [route.revalidate]: (ctx) => ctx.currentRouteName !== 'home',
 *   home: () => <HomePage />
 * }
 * ```
 */
const revalidateSymbol = Symbol('route.revalidate');

/**
 * Route function type with attached symbols
 */
export interface RouteFunction {
  <const T extends Record<string, RouteDefinition>>(
    definitions: T
  ): ResolvedRouteMap<T>;

  layout: typeof layoutSymbol;
  parallel: typeof parallelSymbol;
  loading: typeof loadingSymbol;
  error: typeof errorSymbol;
  revalidate: typeof revalidateSymbol;
}

/**
 * Creates a typed route map from route definitions
 *
 * @param definitions - Object mapping route names to path patterns or nested route definitions
 * @returns RouteMap instance with full type safety and property access
 *
 * @example
 * Simple routes:
 * ```typescript
 * const routes = route({
 *   home: '/',
 *   about: '/about',
 *   user: '/users/:id'
 * });
 *
 * routes.home // '/'
 * routes.get('user') // '/users/:id'
 * routes.getRouteNames() // ['home', 'about', 'user']
 * ```
 *
 * @example
 * Nested routes:
 * ```typescript
 * const routes = route({
 *   blog: {
 *     index: '/blog',
 *     post: '/blog/:slug'
 *   },
 *   admin: {
 *     users: {
 *       list: '/admin/users',
 *       detail: '/admin/users/:id'
 *     }
 *   }
 * });
 *
 * routes.blog.index // '/blog'
 * routes.admin.users.list // '/admin/users'
 * routes.blog.getRouteNames() // ['index', 'post']
 * routes.getAllPaths() // ['/blog', '/blog/:slug', '/admin/users', '/admin/users/:id']
 * ```
 */
const routeFunction = function route<
  const T extends Record<string, RouteDefinition>,
>(definitions: T): ResolvedRouteMap<T> {
  return new RouteMap(definitions) as ResolvedRouteMap<T>;
} as RouteFunction;

/**
 * Attach symbols to route function for use in route handlers
 */
routeFunction.layout = layoutSymbol;
routeFunction.parallel = parallelSymbol;
routeFunction.loading = loadingSymbol;
routeFunction.error = errorSymbol;
routeFunction.revalidate = revalidateSymbol;

/**
 * Export as route
 */
export { routeFunction as route };

/**
 * Export symbols individually for convenience
 */
export {
  layoutSymbol,
  parallelSymbol,
  loadingSymbol,
  errorSymbol,
  revalidateSymbol,
};

/**
 * Route handler function type
 * Handlers can be sync, async, with or without context
 */
export type RouteHandler =
  | ((ctx: any) => any)
  | ((ctx?: any) => any)
  | (() => any);

/**
 * Recursively build handler type from route map
 * - String routes → RouteHandler
 * - Nested routes → Nested handler object
 */
export type HandlersForRouteMap<T extends Record<string, RouteDefinition>> = {
  [K in keyof T]?: T[K] extends string
    ? RouteHandler
    : T[K] extends Record<string, RouteDefinition>
      ? HandlersForRouteMap<T[K]>
      : never;
} & {
  // Allow special symbols
  [K: symbol]: any; // Allow all symbols
};

/**
 * Type-safe handler map helper
 * Use this when defining handlers in a separate file for type safety
 *
 * @param routes - Route map (from route() function)
 * @param handlers - Handler object matching route structure
 * @returns The handlers object (type-safe)
 *
 * @example
 * File: routes.ts
 * ```typescript
 * export const blogRoutes = route({
 *   index: '/blog',
 *   post: '/blog/:slug'
 * });
 * ```
 *
 * @example
 * File: handlers.ts
 * ```typescript
 * import { map } from 'rsc-router';
 * import { blogRoutes } from './routes';
 *
 * export default map(blogRoutes, {
 *   [route.layout]: BlogLayout,
 *   index: () => <BlogIndex />,
 *   post: (ctx) => <BlogPost slug={ctx.params.slug} />
 * });
 * ```
 *
 * @example
 * File: app.ts
 * ```typescript
 * import { blogRoutes } from './routes';
 * import blogHandlers from './handlers';
 *
 * router.route('/blog', blogRoutes).map(blogHandlers);
 * ```
 */
export function map<T extends Record<string, RouteDefinition>>(
  _routes: ResolvedRouteMap<T>,
  handlers: HandlersForRouteMap<T>
): HandlersForRouteMap<T> {
  // This is a pass-through function for type safety only
  // The actual type checking happens at the parameter level
  // TypeScript enforces that handler keys match route names
  return handlers;
}
