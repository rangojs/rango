import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
} from "./types.js";

/**
 * Branded symbol types for type-safe constraints
 */
export type LayoutSymbol = symbol & { readonly __brand: "layout" };
export type ParallelSymbol = symbol & { readonly __brand: "parallel" };
export type MiddlewareSymbol = symbol & { readonly __brand: "middleware" };
export type RevalidateSymbol = symbol & { readonly __brand: "revalidate" };
export type AllLayoutSymbol = symbol & { readonly __brand: "all.layout" };
export type AllParallelSymbol = symbol & { readonly __brand: "all.parallel" };
export type AllMiddlewareSymbol = symbol & {
  readonly __brand: "all.middleware";
};
export type AllRevalidateSymbol = symbol & {
  readonly __brand: "all.revalidate";
};

/**
 * Symbol caches for each type (enables multiple unique symbols)
 */
const layoutSymbols = new Map<string, symbol>();
const parallelSymbols = new Map<string, symbol>();
const middlewareSymbols = new Map<string, symbol>();
const allLayoutSymbols = new Map<string, symbol>();
const allParallelSymbols = new Map<string, symbol>();
const allMiddlewareSymbols = new Map<string, symbol>();
const allRevalidateSymbols = new Map<string, symbol>();

// Counter for auto-generating unique names
let symbolCounter = 0;

/**
 * Route function with symbol getters
 */
interface RouteFn {
  <const T extends RouteDefinition>(routes: T): ResolvedRouteMap<T>;
  get layout(): LayoutSymbol;
  get parallel(): ParallelSymbol;
  get middleware(): MiddlewareSymbol;
  readonly revalidate: RevalidateSymbol;
  readonly all: {
    get layout(): AllLayoutSymbol;
    get parallel(): AllParallelSymbol;
    get middleware(): AllMiddlewareSymbol;
    get revalidate(): AllRevalidateSymbol;
  };
}

/**
 * Define a route map with patterns
 *
 * @example
 * ```typescript
 * const blogRoutes = route({
 *   index: '/blog',
 *   post: '/blog/:slug',
 *   category: '/blog/:category/:id'
 * });
 * ```
 */
export const route = function <const T extends RouteDefinition>(
  routes: T
): ResolvedRouteMap<T> {
  return flattenRoutes(routes, "") as ResolvedRouteMap<T>;
} as RouteFn;

// Implement symbol getters (return new symbol each time)
Object.defineProperty(route, 'layout', {
  get() {
    return Symbol(`route.layout.${symbolCounter++}`) as LayoutSymbol;
  }
});

Object.defineProperty(route, 'parallel', {
  get() {
    return Symbol(`route.parallel.${symbolCounter++}`) as ParallelSymbol;
  }
});

Object.defineProperty(route, 'middleware', {
  get() {
    return Symbol(`route.middleware.${symbolCounter++}`) as MiddlewareSymbol;
  }
});

(route as any).revalidate = Symbol('route.revalidate') as RevalidateSymbol;

// Attach route.all namespace with getters
(route as any).all = {};

Object.defineProperty((route as any).all, 'layout', {
  get() {
    return Symbol(`route.all.layout.${symbolCounter++}`) as AllLayoutSymbol;
  }
});

Object.defineProperty((route as any).all, 'parallel', {
  get() {
    return Symbol(`route.all.parallel.${symbolCounter++}`) as AllParallelSymbol;
  }
});

Object.defineProperty((route as any).all, 'middleware', {
  get() {
    return Symbol(`route.all.middleware.${symbolCounter++}`) as AllMiddlewareSymbol;
  }
});

Object.defineProperty((route as any).all, 'revalidate', {
  get() {
    return Symbol(`route.all.revalidate.${symbolCounter++}`) as AllRevalidateSymbol;
  }
});

/**
 * Flatten nested route definitions
 */
function flattenRoutes(
  routes: RouteDefinition,
  prefix: string
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(routes)) {
    if (typeof value === "string") {
      // Direct route pattern
      flattened[key] = value;
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(value, `${prefix}${key}.`);
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

/**
 * Type-safe handler definition helper
 *
 * @example
 * ```typescript
 * export default map<typeof blogRoutes>({
 *   [route.layout]: BlogLayout,
 *   index: (ctx) => <BlogIndex />,
 *   post: (ctx) => <BlogPost slug={ctx.params.slug} />
 * });
 * ```
 */
export function map<T extends RouteDefinition, TContext = any>(
  handlers: HandlersForRouteMap<T, TContext>
): HandlersForRouteMap<T, TContext> {
  // Pass-through for type safety
  return handlers;
}
