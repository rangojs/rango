/**
 * Global namespace for module augmentation
 *
 * Users augment these interfaces for type-safe context:
 *
 * @example
 * ```typescript
 * // In env.ts or env.d.ts
 * declare global {
 *   namespace RSCRouter {
 *     interface Env extends AppBindings {}
 *     interface Vars extends AppVariables {}
 *   }
 * }
 *
 * // Now all handlers have type-safe context without imports!
 * // ctx.env.DB, ctx.get("user"), etc.
 * ```
 */
declare global {
  namespace RSCRouter {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Env {
      // Empty by default - users augment with their bindings (e.g., { DB: D1Database })
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Vars {
      // Empty by default - users augment with their variables (e.g., { user?: User })
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface RegisteredRoutes {
      // Empty by default - users augment with their merged route maps for type-safe href()
      // Values are string (pattern) for RSC routes, or { path: string; response: T } for response routes
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface GeneratedRouteMap {
      // Empty by default - populated by generated named-routes.gen.ts
      // Maps route names to URL pattern strings for Handler<"routeName"> support
    }
  }
}

/**
 * Get registered routes or fallback to generic Record<string, string>
 * When RSCRouter.RegisteredRoutes is augmented, provides autocomplete for route names
 * When not augmented, allows any string (no autocomplete)
 */
export type GetRegisteredRoutes = keyof RSCRouter.RegisteredRoutes extends never
  ? Record<string, string>
  : RSCRouter.RegisteredRoutes;

/**
 * Default route map for reverse() surfaces.
 * Prefers GeneratedRouteMap to avoid router.tsx -> urls.tsx -> types -> router.tsx
 * cycles, but falls back to RegisteredRoutes for manual augmentation and then to
 * a permissive record when no route types are available.
 */
export type DefaultReverseRouteMap =
  keyof RSCRouter.GeneratedRouteMap extends never
    ? keyof RSCRouter.RegisteredRoutes extends never
      ? Record<string, string>
      : RSCRouter.RegisteredRoutes
    : RSCRouter.GeneratedRouteMap;

/**
 * Default route map for Handler type.
 * Uses GeneratedRouteMap (from gen file) instead of RegisteredRoutes to avoid
 * circular dependencies: router.tsx -> urls.tsx -> handler.tsx -> RegisteredRoutes -> router.tsx.
 * GeneratedRouteMap is declared in a standalone gen file with no imports.
 */
export type DefaultHandlerRouteMap =
  keyof RSCRouter.GeneratedRouteMap extends never
    ? {}
    : RSCRouter.GeneratedRouteMap;

/**
 * Default environment type - uses global augmentation if available, any otherwise
 */
export type DefaultEnv = keyof RSCRouter.Env extends never
  ? any
  : RSCRouter.Env;

/**
 * Default variables type - uses global augmentation if available, Record<string, any> otherwise
 */
export type DefaultVars = keyof RSCRouter.Vars extends never
  ? Record<string, any>
  : RSCRouter.Vars;
