import type { ComponentType, ReactNode } from "react";
import type { SegmentCacheStore } from "../cache/types.js";
import type {
  ErrorBoundaryHandler,
  NotFoundBoundaryHandler,
  OnErrorCallback,
} from "../types";
import type { NonceProvider } from "../rsc/types.js";
import type { ExecutionContext } from "../server/request-context.js";
import type { UrlPatterns } from "../urls.js";
import type { NamedRouteEntry } from "./content-negotiation.js";

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router configuration options
 */
export interface RSCRouterOptions<TEnv = any> {
  /**
   * Unique identifier for this router instance.
   * Used to namespace static output files and route maps.
   * Auto-generated if not provided.
   */
  id?: string;

  /**
   * Injected by the Vite transform at compile time.
   * Hash of filename + line number for stable cross-environment ID.
   * @internal
   */
  $$id?: string;

  /**
   * Injected by the Vite transform at compile time.
   * Absolute path of the source file that defines this router,
   * relative to project root. Eliminates runtime stack trace parsing.
   * @internal
   */
  $$sourceFile?: string;

  /**
   * Enable performance metrics collection
   * When enabled, metrics are output to console and available via Server-Timing header
   */
  debugPerformance?: boolean;

  /**
   * Allow the `?__debug_manifest` query parameter to return route manifest data as JSON.
   * In development mode this is always enabled regardless of this setting.
   * Defaults to false. Set to true to enable in production.
   * @internal
   */
  allowDebugManifest?: boolean;

  /**
   * Document component that wraps the entire application.
   *
   * This component provides the HTML structure for your app and wraps
   * both normal route content AND error states, preventing the app shell
   * from unmounting during errors (avoids FOUC).
   *
   * Must be a client component ("use client") that accepts { children }.
   *
   * If not provided, a default document with basic HTML structure is used:
   * `<html><head><meta charset/viewport></head><body>{children}</body></html>`
   *
   * @example
   * ```typescript
   * // components/Document.tsx
   * "use client";
   * export function Document({ children }: { children: ReactNode }) {
   *   return (
   *     <html lang="en">
   *       <head>
   *         <link rel="stylesheet" href="/styles.css" />
   *       </head>
   *       <body>
   *         <nav>...</nav>
   *         {children}
   *       </body>
   *     </html>
   *   );
   * }
   *
   * // router.tsx
   * const router = createRouter<AppBindings>({
   *   document: Document,
   * });
   * ```
   */
  document?: ComponentType<RootLayoutProps>;

  /**
   * Default error boundary fallback used when no error boundary is defined in the route tree
   * If not provided, errors will propagate and crash the request
   */
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  /**
   * Default not-found boundary fallback used when no notFoundBoundary is defined in the route tree
   * If not provided, DataNotFoundError will be treated as a regular error
   */
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;

  /**
   * Component to render when no route matches the requested URL.
   *
   * This is rendered within your document/app shell with a 404 status code.
   * Use this for a custom 404 page that maintains your app's look and feel.
   *
   * If not provided, a default "Page not found" component is rendered.
   *
   * Can be a static ReactNode or a function receiving the pathname.
   *
   * @example
   * ```typescript
   * // Simple static component
   * const router = createRouter<AppBindings>({
   *   document: Document,
   *   notFound: <NotFound404 />,
   * });
   *
   * // Dynamic component with pathname
   * const router = createRouter<AppBindings>({
   *   document: Document,
   *   notFound: ({ pathname }) => (
   *     <div>
   *       <h1>404 - Not Found</h1>
   *       <p>No page exists at {pathname}</p>
   *       <a href="/">Go home</a>
   *     </div>
   *   ),
   * });
   * ```
   */
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode);

  /**
   * Callback invoked when an error occurs during request handling.
   *
   * This callback is for notification/logging purposes - it cannot modify
   * the error handling flow. Use errorBoundary() in route definitions to
   * customize error UI.
   *
   * The callback receives comprehensive context about the error including:
   * - The error itself
   * - Phase where it occurred (routing, middleware, loader, handler, etc.)
   * - Request info (URL, method, params)
   * - Route info (routeKey, segmentId)
   * - Environment/bindings
   * - Duration from request start
   *
   * @example
   * ```typescript
   * const router = createRouter<AppBindings>({
   *   onError: (context) => {
   *     // Send to error tracking service
   *     Sentry.captureException(context.error, {
   *       tags: {
   *         phase: context.phase,
   *         route: context.routeKey,
   *       },
   *       extra: {
   *         url: context.url.toString(),
   *         params: context.params,
   *         duration: context.duration,
   *       },
   *     });
   *   },
   * });
   * ```
   */
  onError?: OnErrorCallback<TEnv>;

  /**
   * Cache store for segment caching.
   *
   * When provided, enables route-level caching via cache() boundaries.
   * The store handles persistence (memory, KV, Redis, etc.).
   *
   * Can be a static config or a function receiving env for runtime bindings.
   *
   * @example Static config
   * ```typescript
   * import { MemorySegmentCacheStore } from "rsc-router/rsc";
   *
   * const router = createRouter({
   *   cache: {
   *     store: new MemorySegmentCacheStore({ defaults: { ttl: 60 } }),
   *   },
   * });
   * ```
   *
   * @example Dynamic config with env (e.g., Cloudflare Workers with ExecutionContext)
   * ```typescript
   * const router = createRouter<AppBindings>({
   *   cache: (env, ctx) => ({
   *     store: new CFCacheStore({
   *       defaults: { ttl: 60 },
   *       ctx, // ExecutionContext for non-blocking writes
   *     }),
   *   }),
   * });
   * ```
   */
  cache?:
    | { store: SegmentCacheStore; enabled?: boolean }
    | ((
        env: TEnv,
        ctx?: ExecutionContext,
      ) => {
        store: SegmentCacheStore;
        enabled?: boolean;
      });

  /**
   * Named cache profiles for "use cache" directive.
   * Profile names map to TTL/SWR configuration.
   *
   * - `"use cache"` (no name) resolves to the `default` profile.
   * - `"use cache: short"` resolves to the `short` profile.
   *
   * @example
   * ```typescript
   * createRouter({
   *   cacheProfiles: {
   *     default: { ttl: 900, swr: 1800 },
   *     short:   { ttl: 60, swr: 120 },
   *     long:    { ttl: 3600, swr: 7200 },
   *     products: { ttl: 300, swr: 600, tags: ['products'] },
   *   },
   * });
   * ```
   */
  cacheProfiles?: Record<
    string,
    import("../cache/profile-registry.js").CacheProfile
  >;

  /**
   * Theme configuration for automatic theme management.
   *
   * When provided, enables:
   * - ctx.theme and ctx.setTheme() in route handlers
   * - useTheme() hook for client components
   * - FOUC prevention via inline script in MetaTags
   * - Automatic ThemeProvider wrapping in NavigationProvider
   *
   * @example
   * ```typescript
   * const router = createRouter<AppBindings>({
   *   theme: {
   *     defaultTheme: "system",
   *     themes: ["light", "dark"],
   *   }
   * });
   *
   * // In route handler:
   * route("settings", (ctx) => {
   *   const theme = ctx.theme;     // "light" | "dark" | "system"
   *   ctx.setTheme("dark");        // Sets cookie
   *   return <SettingsPage />;
   * });
   *
   * // In client component:
   * import { useTheme } from "@rangojs/router/theme";
   *
   * function ThemeToggle() {
   *   const { theme, setTheme, themes } = useTheme();
   *   return <select value={theme} onChange={e => setTheme(e.target.value)}>
   *     {themes.map(t => <option key={t}>{t}</option>)}
   *   </select>;
   * }
   * ```
   *
   * Use `theme: true` to enable with all defaults.
   */
  theme?: import("../theme/types.js").ThemeConfig | true;

  /**
   * URL patterns to register with the router.
   *
   * Alternative to calling `.routes()` method - allows passing patterns
   * directly in the config for a more concise setup.
   *
   * @example
   * ```typescript
   * import { urls } from "@rangojs/router/server";
   *
   * const urlpatterns = urls(({ path, layout }) => [
   *   path("/", HomePage, { name: "home" }),
   *   path("/about", AboutPage, { name: "about" }),
   * ]);
   *
   * const router = createRouter<AppBindings>({
   *   document: Document,
   *   urls: urlpatterns,
   * });
   * ```
   */
  urls?: UrlPatterns<TEnv, any>;

  /**
   * Injected by the Vite transform at compile time.
   * Static import of NamedRoutes from the generated named-routes file.
   * Used to seed reverse() with the full named route map.
   * @internal
   */
  $$routeNames?: Record<string, NamedRouteEntry>;

  /**
   * Nonce provider for Content Security Policy (CSP).
   *
   * Can be:
   * - A function that returns a nonce string
   * - A function that returns `true` to auto-generate a nonce
   * - Undefined to disable nonce (default)
   *
   * The nonce will be applied to inline scripts injected by the RSC payload.
   * It's also available to middleware via `ctx.get('nonce')`.
   *
   * @example Auto-generate nonce
   * ```tsx
   * createRouter({
   *   nonce: () => true,
   * });
   * ```
   *
   * @example Custom nonce from request context
   * ```tsx
   * createRouter({
   *   nonce: (request, env) => env.nonce,
   * });
   * ```
   */
  nonce?: NonceProvider<TEnv>;

  /**
   * RSC version string included in metadata.
   * The browser sends this back on partial requests to detect version mismatches.
   *
   * Defaults to the auto-generated VERSION from `@rangojs/router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   *
   * @default VERSION from @rangojs/router:version
   */
  version?: string;

  /**
   * Enable connection warmup to keep TCP+TLS alive after idle periods.
   *
   * When enabled, the client sends a HEAD request after the user returns
   * from an idle period (60s+), prewarming the TLS connection before
   * the next navigation.
   *
   * @default true
   */
  warmup?: boolean;
}
