/**
 * Global namespace for module augmentation
 *
 * Users augment these interfaces for type-safe context:
 *
 * @example
 * ```typescript
 * // In env.ts or env.d.ts
 * declare global {
 *   namespace Rango {
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
  namespace Rango {
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
 * Route map for path-validation surfaces (`href`, `ValidPaths`, `PathResponse`).
 *
 * Resolution order:
 * 1. `RegisteredRoutes` — manual `extends typeof router.routeMap`; richest map,
 *    the only one carrying response-route payload metadata.
 * 2. `GeneratedRouteMap` — auto-wired by `router.named-routes.gen.ts`; path +
 *    search only. Lets `rango generate` alone enable `href()`/`ValidPaths` path
 *    checking without a manual `RegisteredRoutes` declaration.
 * 3. `Record<string, string>` — permissive fallback when nothing is registered.
 *
 * Referencing `GeneratedRouteMap` here is cycle-safe: it is declared in the
 * standalone gen file with no imports, unlike `RegisteredRoutes extends typeof
 * router.routeMap`.
 */
export type GetRegisteredRoutes = keyof Rango.RegisteredRoutes extends never
  ? keyof Rango.GeneratedRouteMap extends never
    ? Record<string, string>
    : Rango.GeneratedRouteMap
  : Rango.RegisteredRoutes;

/**
 * Default route map for reverse() surfaces.
 * Prefers GeneratedRouteMap to avoid router.tsx -> urls.tsx -> types -> router.tsx
 * cycles, but falls back to RegisteredRoutes for manual augmentation and then to
 * a permissive record when no route types are available.
 */
export type DefaultReverseRouteMap = keyof Rango.GeneratedRouteMap extends never
  ? keyof Rango.RegisteredRoutes extends never
    ? Record<string, string>
    : Rango.RegisteredRoutes
  : Rango.GeneratedRouteMap;

/**
 * Default route map for Handler type.
 * Uses GeneratedRouteMap (from gen file) instead of RegisteredRoutes to avoid
 * circular dependencies: router.tsx -> urls.tsx -> handler.tsx -> RegisteredRoutes -> router.tsx.
 * GeneratedRouteMap is declared in a standalone gen file with no imports.
 */
export type DefaultHandlerRouteMap = keyof Rango.GeneratedRouteMap extends never
  ? {}
  : Rango.GeneratedRouteMap;

/**
 * Default environment type - uses global augmentation if available.
 *
 * Falls back to `unknown` (not `any`) when `Rango.Env` is not augmented, so
 * an app that forgets to register its bindings gets a compile error on
 * `ctx.env.SOMETHING` instead of silently losing all env type-checking. Augment
 * `Rango.Env` to type `ctx.env`.
 */
export type DefaultEnv = keyof Rango.Env extends never ? unknown : Rango.Env;

/**
 * Variables type backing the string-key `ctx.get` / `ctx.set` overloads.
 *
 * Uses `Rango.Vars` augmentation when present; otherwise falls back to
 * `Record<string, any>` so an un-augmented app can use string-key vars with
 * zero config -- at the cost of a typo'd key being silently `any`.
 *
 * This `any` fallback is deliberate (see #561) and is an intentional asymmetry
 * with `DefaultEnv` above, which falls back to `unknown`: env bindings are
 * platform-critical and should be registered, so a forgotten binding is made a
 * compile error; vars are ad-hoc and middleware-set, so the zero-config path
 * wins. Augment `Rango.Vars` for type-safe keys.
 */
export type DefaultVars = keyof Rango.Vars extends never
  ? Record<string, any>
  : Rango.Vars;

/**
 * Default route name type for public `routeName` on contexts.
 * When GeneratedRouteMap is augmented, narrows to the known route names.
 * Otherwise falls back to `string` for untyped usage.
 */
export type DefaultRouteName = keyof Rango.GeneratedRouteMap extends never
  ? string
  : keyof Rango.GeneratedRouteMap & string;
