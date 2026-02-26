/**
 * Global namespace for module augmentation
 *
 * Users can augment this to provide type-safe context globally:
 *
 * @example
 * ```typescript
 * // In router.tsx or env.d.ts
 * declare global {
 *   namespace RSCRouter {
 *     interface Env extends RouterEnv<AppBindings, AppVariables> {}
 *   }
 * }
 *
 * // Now all handlers have type-safe context without imports!
 * export default map<typeof shopRoutes>({
 *   [middleware('*', 'auth')]: [
 *     (ctx, next) => {
 *       ctx.set('user', ...) // Type-safe!
 *     }
 *   ]
 * })
 * ```
 */
declare global {
  namespace RSCRouter {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Env {
      // Empty by default - users augment with their RouterEnv
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
