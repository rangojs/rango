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
import type { UrlBuilder } from "../urls/pattern-types.js";
import type { NamedRouteEntry } from "./content-negotiation.js";
import type { TelemetrySink } from "./telemetry.js";
import type { RouterTimeouts, OnTimeoutCallback } from "./timeout.js";

/**
 * SSR stream mode returned by resolveStreaming.
 *
 * - `"stream"` — start flushing HTML as soon as the shell is ready
 *   (default React SSR behavior via `renderToReadableStream`).
 * - `"allReady"` — wait for every Suspense boundary to resolve before
 *   sending any bytes (equivalent to awaiting `stream.allReady`).
 */
export type SSRStreamMode = "stream" | "allReady";

/**
 * Context passed to the resolveStreaming callback.
 */
export interface ResolveStreamingContext<TEnv = unknown> {
  request: Request;
  env: TEnv;
  url: URL;
}

/**
 * SSR configuration options.
 */
export interface SSROptions<TEnv = unknown> {
  /**
   * Determine whether an HTML response should stream progressively or
   * wait for full readiness before flushing.
   *
   * Called once per HTML request, before the HTML response is produced.
   * Does NOT apply to RSC responses (`__rsc`, partial navigation, prefetch).
   *
   * Return `"stream"` (default) for progressive streaming or `"allReady"`
   * to buffer the complete HTML before sending.
   *
   * @example Bot detection
   * ```ts
   * createRouter({
   *   ssr: {
   *     resolveStreaming: async ({ request, env }) => {
   *       const bot = await detectBot(request, env);
   *       return bot.isBot && !bot.supportsStreaming ? "allReady" : "stream";
   *     },
   *   },
   * });
   * ```
   */
  resolveStreaming?: (
    context: ResolveStreamingContext<TEnv>,
  ) => SSRStreamMode | Promise<SSRStreamMode>;
}

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router configuration options
 */
export interface RangoOptions<TEnv = any> {
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
   * URL prefix applied to all routes registered with this router.
   *
   * Useful when the app is served under a sub-path (e.g. `/admin` or `/v2`).
   * All `path()` patterns are automatically prefixed and `reverse()` returns
   * full paths including the basename. Route names are NOT prefixed.
   *
   * @example
   * ```typescript
   * const router = createRouter({
   *   basename: "/admin",
   * }).routes(({ path }) => [
   *   path("/", Dashboard, { name: "home" }),       // matches /admin
   *   path("/users", Users, { name: "users" }),     // matches /admin/users
   * ]);
   *
   * router.reverse("home");   // "/admin"
   * router.reverse("users");  // "/admin/users"
   * ```
   */
  basename?: string;

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
   * DEVELOPMENT/TEST ONLY. Emit an `X-Rango-Cache` response header describing
   * the cache status of the matched route, for use by testing primitives such
   * as `assertCacheStatus`.
   *
   * Defaults to `false`. When neither this option nor the
   * `RANGO_TEST_SIGNALS=1` environment flag is set, NO header is emitted and
   * router output is byte-identical to the default.
   *
   * The header encodes per-segment (v1: coarse route-level) status keyed by the
   * route NAME, e.g. `X-Rango-Cache: product.detail=hit`. Do NOT enable in
   * production — it exposes internal cache decisions.
   */
  debugCacheSignal?: boolean;

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
   * const router = createRouter<AppEnv>({
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
   * const router = createRouter<AppEnv>({
   *   document: Document,
   *   notFound: <NotFound404 />,
   * });
   *
   * // Dynamic component with pathname
   * const router = createRouter<AppEnv>({
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
   * const router = createRouter<AppEnv>({
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
   * import { MemorySegmentCacheStore } from "@rangojs/router/cache";
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
   *   cache: (_env, ctx) => ({
   *     store: new CFCacheStore({
   *       defaults: { ttl: 60 },
   *       ctx: ctx!, // ExecutionContext for non-blocking writes
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
   * const router = createRouter<AppEnv>({
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
   * Default for whether the router wraps `transition()` segments in its own
   * React `<ViewTransition>` boundary (experimental React only).
   *
   * - "auto" (default): every route/layout that opts in via `transition()`
   *   gets a router-owned cross-fade.
   * - false: the router never places its own boundary. Routes that use
   *   `transition()` still drive navigation through startTransition (so loaders
   *   hold instead of flashing a skeleton) and still let consumer-placed
   *   `<ViewTransition>` elements animate — the router just contributes no
   *   cross-fade of its own. This is the "router triggers, you place the
   *   transitions" model.
   *
   * A per-segment `transition({ viewTransition })` overrides this default.
   *
   * @example
   * ```typescript
   * // App-wide: drive + hold, but never auto-wrap. Place <ViewTransition>
   * // yourself in components where you want a morph.
   * const router = createRouter<AppEnv>({ viewTransition: false });
   * ```
   */
  viewTransition?: "auto" | false;

  /**
   * URL patterns to register with the router.
   *
   * Accepts either a `UrlPatterns` object from `urls()` or a builder function
   * directly (urls() is called implicitly).
   *
   * @example
   * ```typescript
   * // With urls()
   * createRouter<AppEnv>({
   *   document: Document,
   *   urls: urlpatterns,
   * });
   *
   * // With builder function
   * createRouter<AppEnv>({
   *   document: Document,
   *   urls: ({ path }) => [
   *     path("/", HomePage, { name: "home" }),
   *     path("/about", AboutPage, { name: "about" }),
   *   ],
   * });
   * ```
   */
  urls?: UrlPatterns<TEnv, any> | UrlBuilder<TEnv>;

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
   * It's also available to middleware via the typed `nonce` token:
   * `import { nonce } from "@rangojs/router"; ctx.get(nonce)`
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
   *
   * @example Access nonce in middleware
   * ```tsx
   * import { nonce } from "@rangojs/router";
   *
   * const cspMiddleware: Middleware = async (ctx, next) => {
   *   const value = ctx.get(nonce); // string | undefined
   *   await next();
   * };
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
   * TTL (in seconds) for the in-memory prefetch cache and the
   * Cache-Control header on prefetch responses.
   *
   * Controls how long prefetch responses are kept in the client-side
   * in-memory cache and sets `Cache-Control: private, max-age=<ttl>`
   * on server responses for CDN/edge caching.
   *
   * The cache is automatically invalidated on server actions regardless
   * of TTL, so this is primarily a staleness safety net.
   *
   * Set to `false` to disable prefetch caching entirely.
   *
   * @default 300 (5 minutes)
   */
  prefetchCacheTTL?: number | false;

  /**
   * Prefix for the rango state cookie name. The resolved name is
   * `{prefix}_{routerId}`; the prefix is sanitized to cookie-name-safe
   * characters (`[A-Za-z0-9-]`) and an empty result falls back to the default.
   *
   * The rango state cookie keys the client's prefetch / HTTP caches. Overriding
   * the prefix lets you align it with cookie-naming policies or consent-manager
   * classification lists, or avoid colliding with an existing `rango-state`
   * cookie. It is not a full-name override: the `_{routerId}` suffix is what
   * keeps sibling apps on one origin from clobbering each other's state.
   *
   * @default "rango-state"
   */
  stateCookiePrefix?: string;

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

  /**
   * Shorthand timeout (ms) applied to both action execution and render start.
   * Does NOT apply to streamIdleMs.
   * Overridden by individual values in `timeouts`.
   *
   * @example
   * ```typescript
   * createRouter({ timeout: 10_000 });
   * ```
   */
  timeout?: number;

  /**
   * Structured timeout configuration per phase.
   * Values here override the `timeout` shorthand.
   *
   * @example
   * ```typescript
   * createRouter({
   *   timeouts: {
   *     actionMs: 10_000,
   *     renderStartMs: 8_000,
   *   },
   * });
   * ```
   */
  timeouts?: RouterTimeouts;

  /**
   * Custom handler invoked when a timeout occurs.
   * Receives context about which phase timed out and must return a Response.
   * If not provided, returns a plain 504 with "Request timed out" body
   * and X-Rango-Timeout-Phase header.
   *
   * If the callback throws, the default 504 response is used as fallback.
   *
   * @example
   * ```typescript
   * createRouter({
   *   timeout: 10_000,
   *   onTimeout: (ctx) => {
   *     return new Response(
   *       JSON.stringify({ error: "timeout", phase: ctx.phase }),
   *       { status: 504, headers: { "Content-Type": "application/json" } },
   *     );
   *   },
   * });
   * ```
   */
  onTimeout?: OnTimeoutCallback<TEnv>;

  /**
   * Telemetry sink for structured lifecycle events.
   *
   * When provided, the router emits events for request start/end,
   * loader start/end/error, handler errors, cache decisions, and
   * revalidation decisions.
   *
   * No-op when not configured (zero overhead).
   *
   * @example Console logging
   * ```typescript
   * import { createConsoleSink } from "@rangojs/router";
   *
   * const router = createRouter({
   *   telemetry: createConsoleSink(),
   * });
   * ```
   *
   * @example Custom sink
   * ```typescript
   * const router = createRouter({
   *   telemetry: {
   *     emit(event) {
   *       myTracer.record(event);
   *     },
   *   },
   * });
   * ```
   */
  telemetry?: TelemetrySink;

  /**
   * SSR configuration options.
   *
   * @example
   * ```typescript
   * createRouter({
   *   ssr: {
   *     resolveStreaming: async ({ request, env }) => {
   *       const bot = await detectBot(request, env);
   *       return bot.isBot ? "allReady" : "stream";
   *     },
   *   },
   * });
   * ```
   */
  ssr?: SSROptions<TEnv>;

  /**
   * Cross-origin request protection for server actions, loader fetches,
   * and progressive enhancement form submissions.
   *
   * When enabled, the router validates that the request's Origin header
   * (or Referer fallback) matches the Host before executing actions,
   * loaders, or PE submissions. Requests without Origin/Referer are
   * allowed (same-origin navigations, non-browser clients).
   *
   * The built-in check compares Origin against the Host header and
   * url.protocol. It does NOT trust X-Forwarded-Host/Proto headers
   * (they are client-controllable without a trusted proxy). On standard
   * deployments (Cloudflare Workers, Node behind nginx/caddy) the Host
   * header is already set to the public-facing host by the platform or
   * proxy. For non-standard proxy setups where Host differs from the
   * public origin, use a custom function that reads the appropriate
   * forwarded headers from your trusted proxy.
   *
   * - `true` (default) -- enable built-in origin validation
   * - `false` -- disable
   * - function -- full custom control with access to env, phase,
   *   and the built-in check via `ctx.defaultCheck()`
   *
   * The callback receives `OriginCheckContext` with `request`, `url`,
   * `env`, `routerId`, `phase` ("action" | "loader" | "pe-form"),
   * and `defaultCheck()`. Return `true` to allow, `false` for default
   * 403 rejection, or a `Response` for custom rejection.
   *
   * @default true
   *
   * @example Trusted proxy with X-Forwarded-Host
   * ```ts
   * createRouter({
   *   originCheck({ request, url, env, defaultCheck }) {
   *     if (env.TRUST_PROXY) {
   *       const origin = request.headers.get("origin");
   *       if (!origin) return true;
   *       if (origin === "null") return false;
   *       const host = request.headers.get("x-forwarded-host")
   *         ?? request.headers.get("host") ?? url.host;
   *       return origin.toLowerCase() === `${url.protocol}//${host}`.toLowerCase();
   *     }
   *     return defaultCheck();
   *   },
   * });
   * ```
   */
  originCheck?: import("../rsc/origin-guard.js").OriginCheckConfig<TEnv>;
}
