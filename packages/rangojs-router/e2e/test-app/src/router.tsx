import {
  cookies,
  createRouter,
  getRequestContext,
  redirect,
  type Middleware,
} from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";

// App-level cache store with defaults
export const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 120 },
});

// Store the last onError call for e2e test verification
export interface OnErrorRecord {
  phase: string;
  message: string;
  actionId?: string;
}
export const onErrorLog: OnErrorRecord[] = [];
export function clearOnErrorLog() {
  onErrorLog.length = 0;
}

/**
 * App-level bindings (platform resources like DB, KV, etc.)
 */
export interface AppBindings {}

/**
 * App-level variables (middleware-injected context)
 * These are typed for ctx.get() and ctx.set() throughout the app
 */
export interface AppVariables {
  user?: { id: string; name: string };
  visitCount?: number;
  middlewareParams?: Record<string, string | undefined>;
  // Route-level middleware variables
  routeMiddlewareApplied?: string;
  middlewareRouteId?: string;
  paramsAvailableInMiddleware?: string;
  // Response route middleware test variables
  outerMw?: string;
  innerMw?: string;
  role?: string;
  // Include + layout middleware test variable
  includeLayoutMw?: string;
  // Handler-first execution order test variable
  handlerData?: string;
  // Prerender ctx test variable
  sharedFromGetParams?: string;
  // Prerender locale test variable
  localeContent?: string;
  // Middleware chain integration test variables
  chainGlobal?: string;
  chainAction?: string;
  chainRouteReport?: string;
  chainIntercept?: string;
  // ALS scope propagation test variables
  alsRequestId?: string;
  alsActionProbe?: string;
  alsActionCustomProbe?: string;
  // Middleware ctx parity test variable
  mwVarTest?: string;
  // use-cache parent-child set test variable
  childData?: string;
  // Action → ctx.set → handler reads test variable
  actionCtxValue?: string;
}

export type AppEnv = AppBindings;

declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}

/**
 * Global middleware - adds X-Global-Middleware header to all responses
 * Note: Middleware defaults to RSCRouter.Env (via DefaultEnv) so no type parameter needed
 */
const globalMiddleware: Middleware = async (ctx, next) => {
  const response = await next();
  response.headers.set("X-Global-Middleware", "applied");
  return response;
};

/**
 * Timing middleware - measures request duration and adds X-Request-Duration header
 */
const timingMiddleware: Middleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  ctx.headers.set("X-Request-Duration", String(duration));
};

/**
 * Auth middleware - pattern-based, only applies to /middleware-test/protected/*
 * Checks for auth cookie, redirects to /middleware-test if not authenticated
 */
const authMiddleware: Middleware = async (ctx, next) => {
  const authToken = cookies().get("auth-token")?.value;
  if (!authToken) {
    // Set a header to indicate redirect happened (for test verification)
    return redirect("/middleware-test?auth=required", 302);
  }
  // Set user info in context for handlers
  ctx.set("user", { id: "123", name: "TestUser" });
  await next();
};

/**
 * Error handling middleware - catches errors and returns custom error response
 * Only applies to /middleware-test/error-handler/*
 */
const errorMiddleware: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx.headers.set("X-Error-Caught", "true");
    ctx.headers.set("X-Error-Message", message);
    return new Response(`Error caught by middleware: ${message}`, {
      status: 500,
      headers: { "X-Error-Caught": "true", "X-Error-Message": message },
    });
  }
};

/**
 * Cookie middleware - sets a response cookie
 * Only applies to /middleware-test/cookies
 */
const cookieMiddleware: Middleware = async (ctx, next) => {
  const jar = cookies();
  // Read existing cookie
  const visitCount = parseInt(jar.get("visit-count")?.value || "0", 10);

  // Set updated cookie
  jar.set("visit-count", String(visitCount + 1), {
    path: "/",
    maxAge: 60 * 60 * 24, // 1 day
  });

  // Make visit count available to handler
  ctx.set("visitCount", visitCount + 1);

  await next();
};

/**
 * Params middleware - extracts params from pattern
 * Pattern: /middleware-test/params/:id
 */
const paramsMiddleware: Middleware = async (ctx, next) => {
  // ctx.params contains extracted route params
  ctx.set("middlewareParams", ctx.params);
  await next();
  ctx.header("X-Middleware-Param-Id", ctx.params.id || "none");
};

/**
 * Header shorthand middleware - uses ctx.header() shorthand
 */
const headerShorthandMiddleware: Middleware = async (ctx, next) => {
  await next();
  ctx.header("X-Header-Shorthand", "works");
};

export const router = createRouter<AppEnv>({
  cache: { store: cacheStore },
  cacheProfiles: {
    short: { ttl: 10, swr: 20 },
    "swr-test": { ttl: 2, swr: 60 },
  },
  prefetchCacheTTL: 60,
  theme: {
    defaultTheme: "light",
    themes: ["light", "dark", "system"],
    attribute: "class",
    storageKey: "theme",
    enableSystem: true,
    enableColorScheme: true,
  },
  ssr: {
    resolveStreaming: ({ request }) => {
      const ua = request.headers.get("user-agent") ?? "";
      if (ua.includes("StreamBot")) return "allReady";
      return "stream";
    },
  },
  onError: (context) => {
    onErrorLog.push({
      phase: context.phase,
      message: context.error.message,
      actionId: context.actionId,
    });
  },
})
  // Bug-repro: cookies set AFTER await next() in the outermost middleware.
  // Registered before globalMiddleware so no outer early-return merge can mask the bug.
  .use("/middleware-test/cookies-after-next", async (_ctx, next) => {
    await next();
    cookies().set("session_id", "abc123", { path: "/", httpOnly: true });
    cookies().set("post-next-marker", "applied", { path: "/" });
  })
  // Global middleware - applied to ALL routes
  .use(globalMiddleware)
  .use(timingMiddleware)
  .use(headerShorthandMiddleware)
  // Stub-header and onResponse test: sets a header before next() and registers
  // an onResponse callback. Verifies these survive when authMiddleware
  // short-circuits with a redirect (returns Response without calling next()).
  .use("/middleware-test/protected/*", async (ctx, next) => {
    ctx.header("X-Stub-Before-Next", "applied");
    const reqCtx = getRequestContext();
    reqCtx?.onResponse((response) => {
      const headers = new Headers(response.headers);
      headers.set("X-OnResponse-Applied", "yes");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    });
    await next();
  })
  // Pattern-based middleware for protected routes
  .use("/middleware-test/protected/*", authMiddleware)
  // Pattern-based middleware for error handling routes
  .use("/middleware-test/error-handler/*", errorMiddleware)
  // Pattern-based middleware for cookie routes
  .use("/middleware-test/cookies", cookieMiddleware)
  // Pattern-based middleware with params
  .use("/middleware-test/params/:id", paramsMiddleware)
  // Middleware chain integration test: global layer sets var, header, cookie
  .use("/mw-chain/*", async (ctx, next) => {
    ctx.set("chainGlobal", "from-global");
    ctx.header("X-Chain-Global", "applied");
    cookies().set("chain-global", "gv", { path: "/", maxAge: 86400 });
    await next();
  })
  // ALS scope propagation test: global middleware sets request-scoped bindings
  // and runs next() inside a custom AsyncLocalStorage to prove user-owned ALS
  // propagates through the framework's render pipeline.
  .use("/als-scope/*", async (ctx, next) => {
    const { AlsGlobalMark, customGlobalAls } =
      await import("./urls/als-scope.js");
    const requestId = crypto.randomUUID();
    ctx.set("alsRequestId", requestId);
    ctx.set(AlsGlobalMark, "applied");
    return customGlobalAls.run(`top-mw:${requestId}`, () => next());
  })
  // Auth boundary test: global middleware guards BOTH actions and renders.
  // Rejects unauthenticated requests with a redirect and a marker cookie.
  .use("/auth-boundary/global-protected/*", async (ctx, next) => {
    if (!cookies().get("auth-boundary-token")?.value) {
      cookies().set("auth-boundary-rejected-by", "global-mw", {
        path: "/",
        maxAge: 60,
      });
      return redirect("/auth-boundary?rejected=global-mw", 302);
    }
    ctx.header("X-Auth-Global-MW", "passed");
    await next();
  })
  // Pre-handler onResponse callback for response cache callback tests.
  // Registers a callback via getRequestContext().onResponse() which lands
  // in savedCallbacks (before the cache block), so it runs on every serve.
  .use("/response-cache/cb-test/*", async (_ctx, next) => {
    const reqCtx = getRequestContext();
    reqCtx?.onResponse((response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Pre-Handler-Ts", String(Date.now()));
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    });
    await next();
  })
  .routes(urlpatterns);

export const reverse = router.reverse;

// Module-level reverse() calls — these run before lazy includes resolve.
// createRouter() seeds reverse() from the generated NamedRoutes map.
export const moduleLevelReverseResults: Record<string, string> = {
  "blog.index": router.reverse("blog.index"),
  "blog.post": router.reverse("blog.post", { postId: "test-post" }),
  "search.index": router.reverse("search.index"),
  "middlewareTest.index": router.reverse("middlewareTest.index"),
};
