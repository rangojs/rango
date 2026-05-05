import { createLoader, cookies } from "@rangojs/router";
import { getCartQuantitySync } from "./cart-store.js";

// Layout-level loader for segment tracking tests
export const LayoutCountLoader = createLoader(async () => {
  "use server";
  return { count: Date.now() };
});

// Simple loader for prerender client component tests
export const PrerenderTestLoader = createLoader(async () => {
  return { test: true, message: "prerender-loader-data" };
});

// 500ms delayed loader for SSR stream-mode tests
export const StreamModeDelayedLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { message: "delayed-content-resolved" };
});

// Product data
const products = [
  {
    id: "product-a",
    name: "Product A",
    price: 99.99,
    description: "First test product",
  },
  {
    id: "product-b",
    name: "Product B",
    price: 149.99,
    description: "Second test product",
  },
  {
    id: "product-c",
    name: "Product C",
    price: 49.99,
    description: "Third test product",
  },
];

/**
 * Load all products
 */
export const ProductsLoader = createLoader(async () => {
  return { products, loadedAt: new Date().toISOString() };
});

/**
 * Load single product by ID
 */
export const ProductDetailLoader = createLoader(async (ctx) => {
  const productId = ctx.params.productId;
  const product = products.find((p) => p.id === productId);
  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }
  return { product, loadedAt: new Date().toISOString() };
});

/**
 * Load cart quantity for a product
 */
export const CartQuantityLoader = createLoader(async (ctx) => {
  const productId = ctx.params.productId!;
  const quantity = getCartQuantitySync(productId);
  return { productId, quantity };
});

// Counter to track loader invocations for revalidation testing
let slowLoaderCount = 0;

/**
 * Slow loader with 1s delay - used to test loading behavior
 * Tracks invocation count to verify revalidation
 */
export const SlowLoader = createLoader(async () => {
  slowLoaderCount++;
  const count = slowLoaderCount;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    message: "Slow data loaded",
    count,
    loadedAt: new Date().toISOString(),
  };
});

// Product data for slow product loader
const slowProducts = [
  {
    id: "slow-product-a",
    name: "Slow Product A",
    price: 199.99,
    description: "Slow loading product for testing",
  },
];

/**
 * Slow product detail loader - 2s delay for testing intercept loading states
 */
export const SlowProductDetailLoader = createLoader(async (ctx) => {
  const productId = ctx.params.productId;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const product = slowProducts.find((p) => p.id === productId) || {
    id: productId,
    name: `Product ${productId}`,
    price: 99.99,
    description: "Dynamic slow loading product",
  };
  return { product, loadedAt: new Date().toISOString() };
});

// Counter to track fetchable loader invocations
let fetchableLoaderCount = 0;

/**
 * Fetchable loader for testing useFetchLoader hook (GET-based loader fetching)
 * The third argument `true` makes this loader fetchable via GET requests
 */
export const FetchableTestLoader = createLoader(
  async (ctx) => {
    fetchableLoaderCount++;
    const id = ctx.params.id || "default";

    // Add delay to ensure loading state is visible in tests
    await new Promise((resolve) => setTimeout(resolve, 300));

    return {
      message: "Fetched via GET!",
      id,
      count: fetchableLoaderCount,
      timestamp: new Date().toISOString(),
    };
  },
  true, // Enable fetchable (GET-based fetching)
);

// ============================================================================
// useLoader / useFetchLoader Feature Tests
// ============================================================================

// Counter for hook test loader
let hookTestLoaderCount = 0;

/**
 * Loader for testing useLoader and useFetchLoader hooks.
 * Fetchable so it can be passed to client components.
 * Also registered on routes via loader() for SSR preloading.
 */
export const HookTestLoader = createLoader(
  async (ctx) => {
    hookTestLoaderCount++;
    const routeId = ctx.params.routeId || "default";

    return {
      routeId,
      count: hookTestLoaderCount,
      source: "server",
      timestamp: new Date().toISOString(),
    };
  },
  true, // Fetchable - allows passing to client components
);

export type HookTestLoaderData = {
  routeId: string;
  count: number;
  source: string;
  timestamp: string;
};

// Counter for second route loader (to test navigation)
let hookTestLoaderBCount = 0;

/**
 * Second loader for testing navigation between routes.
 * Fetchable so it can be passed to client components.
 */
export const HookTestLoaderB = createLoader(
  async (ctx) => {
    hookTestLoaderBCount++;
    const routeId = ctx.params.routeId || "route-b";

    return {
      routeId,
      count: hookTestLoaderBCount,
      source: "server-b",
      timestamp: new Date().toISOString(),
    };
  },
  true, // Fetchable - allows passing to client components
);

/**
 * Fetchable loader for testing useFetchLoader on-demand fetching.
 * This loader is NOT registered on any route - used for client-side fetching only.
 * Has 500ms delay to make loading state observable in tests.
 */
export const UnregisteredLoader = createLoader(
  async (ctx) => {
    // Form actions provide data via formData, load() calls via params
    const id = String(
      ctx.formData?.get("id") ?? ctx.params.id ?? "unregistered",
    );
    // Delay to ensure loading state is visible in tests
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      id,
      message: "Fetched from unregistered loader",
      timestamp: new Date().toISOString(),
    };
  },
  true, // Fetchable - for client-side load() calls
);

/**
 * Loader that throws an error - for testing error state handling
 */
export const ErrorLoader = createLoader(async (ctx) => {
  const shouldFail = ctx.params.shouldFail !== "false";
  if (shouldFail) {
    throw new Error("Intentional loader error for testing");
  }
  return {
    message: "Success - error was bypassed",
    timestamp: new Date().toISOString(),
  };
}, true);

/**
 * Protected loader with middleware - for testing security
 * Middleware checks for an "authToken" param and rejects if missing/invalid
 */
export const ProtectedLoader = createLoader(
  async (ctx) => {
    return {
      secret: "This is protected data",
      userId: ctx.params.userId || "anonymous",
      timestamp: new Date().toISOString(),
    };
  },
  {
    middleware: [
      async (ctx, next) => {
        const authToken = ctx.params.authToken;
        if (!authToken || authToken !== "valid-token") {
          throw new Error("Unauthorized: Invalid or missing auth token");
        }
        await next();
      },
    ],
  },
);

// ============================================================================
// ctx.use(loader) Composition Tests
// Test loaders calling other loaders via ctx.use()
// Also tests memoization - loaders should only run once per request
// ============================================================================

// Counters to track loader invocations for memoization testing
// Reset these per-request by tracking request timestamp
let baseNonFetchableCount = 0;
let baseFetchableCount = 0;
let lastRequestTimestamp = "";

function resetCountersIfNewRequest(timestamp: string) {
  if (timestamp !== lastRequestTimestamp) {
    baseNonFetchableCount = 0;
    baseFetchableCount = 0;
    lastRequestTimestamp = timestamp;
  }
}

/**
 * Base non-fetchable loader - used as a dependency
 * Tracks invocation count to verify memoization
 */
export const BaseNonFetchableLoader = createLoader(async (ctx) => {
  // Use request timestamp to detect new requests
  const requestTimestamp =
    ctx.request.headers.get("x-request-id") || Date.now().toString();
  resetCountersIfNewRequest(requestTimestamp);
  baseNonFetchableCount++;

  return {
    type: "non-fetchable",
    id: ctx.params.id || "base",
    value: 100,
    invocationCount: baseNonFetchableCount,
  };
});

/**
 * Base fetchable loader - used as a dependency
 * Tracks invocation count to verify memoization
 */
export const BaseFetchableLoader = createLoader(
  async (ctx) => {
    // Use request timestamp to detect new requests
    const requestTimestamp =
      ctx.request.headers.get("x-request-id") || Date.now().toString();
    resetCountersIfNewRequest(requestTimestamp);
    baseFetchableCount++;

    return {
      type: "fetchable",
      id: ctx.params.id || "base",
      value: 200,
      invocationCount: baseFetchableCount,
    };
  },
  true, // fetchable
);

/**
 * Non-fetchable loader that uses another non-fetchable loader via ctx.use()
 */
export const ComposingNonFetchableUsesNonFetchable = createLoader(
  async (ctx) => {
    const base = await ctx.use(BaseNonFetchableLoader);
    return {
      composerType: "non-fetchable",
      dependencyType: "non-fetchable",
      baseValue: base.value,
      baseInvocationCount: base.invocationCount,
      computed: base.value * 2,
    };
  },
);

/**
 * Non-fetchable loader that uses a fetchable loader via ctx.use()
 */
export const ComposingNonFetchableUsesFetchable = createLoader(async (ctx) => {
  const base = await ctx.use(BaseFetchableLoader);
  return {
    composerType: "non-fetchable",
    dependencyType: "fetchable",
    baseValue: base.value,
    baseInvocationCount: base.invocationCount,
    computed: base.value * 2,
  };
});

/**
 * Fetchable loader that uses another fetchable loader via ctx.use()
 */
export const ComposingFetchableUsesFetchable = createLoader(
  async (ctx) => {
    const base = await ctx.use(BaseFetchableLoader);
    return {
      composerType: "fetchable",
      dependencyType: "fetchable",
      baseValue: base.value,
      baseInvocationCount: base.invocationCount,
      computed: base.value * 3,
    };
  },
  true, // fetchable
);

/**
 * Fetchable loader that uses a non-fetchable loader via ctx.use()
 */
export const ComposingFetchableUsesNonFetchable = createLoader(
  async (ctx) => {
    const base = await ctx.use(BaseNonFetchableLoader);
    return {
      composerType: "fetchable",
      dependencyType: "non-fetchable",
      baseValue: base.value,
      baseInvocationCount: base.invocationCount,
      computed: base.value * 3,
    };
  },
  true, // fetchable
);

// ============================================================================
// Cache Testing Loaders
// These loaders are used to test loader caching behavior
// ============================================================================

// Loader that returns a fresh timestamp on every request.
// Used to verify loaders on pre-rendered routes run at request time.
export const FreshTimestampLoader = createLoader(async () => ({
  timestamp: Date.now(),
}));

// Counter for non-cached loader
let nonCachedLoaderCount = 0;

/**
 * Non-cached loader (default behavior) - runs on every request
 * Used to verify loaders are NOT cached by default
 */
export const NonCachedTestLoader = createLoader(async () => {
  nonCachedLoaderCount++;
  return {
    count: nonCachedLoaderCount,
    message: "Non-cached loader data",
    loadedAt: new Date().toISOString(),
  };
});

// Counter for cached loader
let cachedLoaderCount = 0;

/**
 * Cached loader - opt-in via cache() in handlers.tsx
 * Used to verify loaders CAN be cached when explicitly configured
 */
export const CachedTestLoader = createLoader(async () => {
  cachedLoaderCount++;
  return {
    count: cachedLoaderCount,
    message: "Cached loader data",
    loadedAt: new Date().toISOString(),
  };
});

// Counter for intercept cache test loader
let interceptCacheLoaderCount = 0;

/**
 * Fetchable loader for intercept cache testing.
 * Used with a client component that calls useLoader - this way the
 * route segment is cached but loader data is fetched fresh.
 */
export const InterceptCacheTestLoader = createLoader(
  async () => {
    interceptCacheLoaderCount++;
    return {
      count: interceptCacheLoaderCount,
      message: "Intercept cache test data",
      loadedAt: new Date().toISOString(),
    };
  },
  true, // fetchable - allows useLoader to get fresh data
);

export type InterceptCacheTestLoaderData = {
  count: number;
  message: string;
  loadedAt: string;
};

// "use cache" loader test — wraps a cached function inside createLoader.
// The loader itself runs every request; the inner getCachedLoaderData()
// returns cached data on subsequent calls.
export const UseCacheTestLoader = createLoader(async () => {
  const { getCachedLoaderData } = await import("./urls/use-cache-fn.js");
  return getCachedLoaderData();
});

// ============================================================================
// Loader reverse() tests
// Test that loaders can use ctx.reverse to generate URLs
// ============================================================================

/**
 * Loader that uses ctx.reverse with global route names
 */
export const LoaderReverseGlobalLoader = createLoader(async (ctx) => {
  const blogIndex = ctx.reverse("blog.index");
  const blogPost = ctx.reverse("blog.post", { postId: "from-loader" });
  const hrefIndex = ctx.reverse("href.index");
  return { blogIndex, blogPost, hrefIndex };
});

/**
 * Loader that uses ctx.reverse with scoped (.name) route names.
 * This loader is used inside an include() scope to test local resolution.
 */
export const LoaderReverseScopedLoader = createLoader(async (ctx) => {
  const localIndex = ctx.reverse(".index");
  const localDetail = ctx.reverse(".detail", { id: "from-scoped-loader" });
  const globalBlog = ctx.reverse("blog.index");
  return { localIndex, localDetail, globalBlog };
});

/**
 * Fetchable loader that uses ctx.reverse with global route names.
 * Client-bound: passed to a client component and read with useLoader().
 */
export const LoaderReverseClientGlobalLoader = createLoader(
  async (ctx) => {
    const blogIndex = ctx.reverse("blog.index");
    const blogPost = ctx.reverse("blog.post", { postId: "from-client-loader" });
    const hrefIndex = ctx.reverse("href.index");
    return { blogIndex, blogPost, hrefIndex };
  },
  true, // fetchable
);

/**
 * Fetchable loader that uses ctx.reverse with scoped (.name) route names.
 * Client-bound: passed to a client component and read with useLoader().
 */
export const LoaderReverseClientScopedLoader = createLoader(
  async (ctx) => {
    const localIndex = ctx.reverse(".index");
    const localDetail = ctx.reverse(".detail", {
      id: "from-client-scoped-loader",
    });
    const globalBlog = ctx.reverse("blog.index");
    return { localIndex, localDetail, globalBlog };
  },
  true, // fetchable
);

// ============================================================================
// Action Redirect Revalidation Test Loader
// Tests that loaders revalidate after action redirect (_skipCache)
// ============================================================================

/**
 * Loader that reads an auth cookie and returns user data.
 * Used to test that after an action sets a cookie and throws redirect,
 * the target route's loader runs fresh (not from stale cache).
 */
export const ActionRedirectAuthLoader = createLoader(async () => {
  const session = cookies().get("test-auth-session")?.value;
  return {
    user: session || null,
    loadedAt: new Date().toISOString(),
  };
});

// Counter to distinguish SSR from client-side refetch
let fetchReverseScopedCount = 0;

/**
 * Fetchable loader for testing the loader-fetch.ts path (useFetchLoader + load()).
 * Uses scoped reverse to verify _routeName is threaded through RequestContext.
 * Includes a count to distinguish SSR data from re-fetched data.
 */
export const LoaderReverseFetchScopedLoader = createLoader(
  async (ctx) => {
    fetchReverseScopedCount++;
    const localIndex = ctx.reverse(".index");
    const localDetail = ctx.reverse(".detail", {
      id: "from-fetch-scoped-loader",
    });
    const globalBlog = ctx.reverse("blog.index");
    return {
      localIndex,
      localDetail,
      globalBlog,
      count: fetchReverseScopedCount,
    };
  },
  true, // fetchable
);

// ============================================================================
// Loader cookies() tests
// Test that loaders can read cookies directly via cookies()
// ============================================================================

/**
 * Loader that reads cookies via cookies().get() and cookies().getAll()
 * Used to test that loaders have cookie access via the standalone cookies() function
 */
export const CookieTestLoader = createLoader(async () => {
  const jar = cookies();
  const testSession = jar.get("test-session")?.value;
  const allCookies = jar.getAll();
  return {
    session: testSession || null,
    cookieCount: allCookies.length,
  };
});

/**
 * Loader that uses cookies().get() to read a cookie set by middleware.
 * Tests the full pipeline: middleware sets cookie -> loader reads it.
 */
export const CookieFromMiddlewareLoader = createLoader(async () => {
  const visitCount = cookies().get("visit-count")?.value;
  return {
    visitCount: visitCount ? parseInt(visitCount, 10) : null,
  };
});

/**
 * Loader that reads the "mw-session" cookie.
 * Used to test action-sets-cookie -> revalidation -> loader-reads-cookie flow.
 */
export const ActionCookieLoader = createLoader(async () => {
  const session = cookies().get("mw-session")?.value ?? null;
  return { session };
});

// ============================================================================
// Loader return type tests (ReactNode, null)
// ============================================================================

// ReactNode loader — returns JSX, only works through RSC Flight serialization.
// JSON.stringify would fail on ReactNode.
let reactNodeLoaderCount = 0;
export const ReactNodeTestLoader = createLoader(async () => {
  reactNodeLoaderCount++;
  const ts = new Date().toISOString();
  return (
    <>
      <span data-testid="rn-count">{reactNodeLoaderCount}</span>
      <span data-testid="rn-ts">{ts}</span>
    </>
  );
});

// Null loader — returns null. The cache must store and return null,
// not treat it as a permanent cache miss.
let nullLoaderCount = 0;
export const NullTestLoader = createLoader(async () => {
  nullLoaderCount++;
  return { value: null, count: nullLoaderCount };
});

// ============================================================================
// ALS scope propagation test loader
// Reads getRequestContext() to prove ALS is accessible from loaders.
// ============================================================================

export const AlsScopeLoader = createLoader(async () => {
  const { getRequestContext } = await import("@rangojs/router");
  const {
    AlsGlobalMark,
    AlsRouteMark,
    AlsInterceptMark,
    customGlobalAls,
    customRouteAls,
  } = await import("./urls/als-scope.js");
  const ctx = getRequestContext();
  const parts: string[] = [];
  if (ctx.get(AlsGlobalMark)) parts.push("global");
  if (ctx.get(AlsRouteMark)) parts.push("route");
  if (ctx.get(AlsInterceptMark)) parts.push("intercept");
  const requestId = ctx.get("alsRequestId") as string | undefined;
  // Read custom ALS instances directly
  const customParts: string[] = [];
  if (customGlobalAls.getStore()) customParts.push("top-mw");
  if (customRouteAls.getStore()) customParts.push("dsl-mw");
  return {
    scope: parts.length > 0 ? parts.join(",") : "none",
    customAls: customParts.length > 0 ? customParts.join(",") : "none",
    requestId: requestId ?? "none",
  };
});

export interface AlsScopeLoaderData {
  scope: string;
  customAls: string;
  requestId: string;
}

// ============================================================================
// Middleware chain integration test loaders
// Reads cookies from all middleware layers to verify the full chain.
// Fetchable so client components can display via useLoader.
// ============================================================================

export interface MwChainLoaderData {
  globalCookie: string | null;
  actionCookie: string | null;
  routeCookie: string | null;
}

export const MwChainLoader = createLoader(
  async () => {
    const jar = cookies();
    return {
      globalCookie: jar.get("chain-global")?.value ?? null,
      actionCookie: jar.get("chain-action")?.value ?? null,
      routeCookie: jar.get("chain-route")?.value ?? null,
    };
  },
  true, // fetchable — allows useLoader in client components
);

export const MwChainParallelLoader = createLoader(
  async () => {
    const jar = cookies();
    return {
      globalCookie: jar.get("chain-global")?.value ?? null,
      actionCookie: jar.get("chain-action")?.value ?? null,
      routeCookie: jar.get("chain-route")?.value ?? null,
    };
  },
  true, // fetchable
);

export const MwChainInterceptLoader = createLoader(
  async () => {
    const jar = cookies();
    return {
      globalCookie: jar.get("chain-global")?.value ?? null,
      actionCookie: jar.get("chain-action")?.value ?? null,
      routeCookie: jar.get("chain-route")?.value ?? null,
    };
  },
  true, // fetchable
);

// ============================================================================
// Parallel loader inheritance test
// ============================================================================

export const ParallelInheritLoader = createLoader(async () => {
  return { source: "route-level", value: "inherited-data" };
});

// ============================================================================
// Parallel loader revalidation (orphan layout) test
// ============================================================================

export const ParallelRevalLoader = createLoader(async () => {
  return { count: Date.now() };
});

// ============================================================================
// Action ctx.set → loader ctx.get test
// Reads context variables set by an action to verify loaders see them
// during the revalidation render pass.
// ============================================================================

export const ActionCtxSetLoader = createLoader(async (ctx) => {
  const { ActionCtxTypedVar } = await import("./urls/action-ctx-set.js");
  const stringValue = ctx.get("actionCtxValue") ?? null;
  const typedValue = ctx.get(ActionCtxTypedVar) ?? null;
  return { stringValue, typedValue };
});

// ============================================================================
// Shared refetch loader
// Counter-based loader for the shared-refetch regression test. Multiple
// components on the same page read this loader; one of them calls load()
// and the test asserts that ALL reading sites pick up the new count.
// ============================================================================

let sharedRefetchCount = 0;

export const SharedRefetchLoader = createLoader(
  async () => {
    sharedRefetchCount++;
    return { count: sharedRefetchCount };
  },
  true, // fetchable — required so client components can call load()
);

// Param-aware variant for the params-stay-local regression. Two components
// call load({ params: { tag } }) with different tags; each component must
// render its own tag, never overwriting the other through the shared store.
let sharedRefetchParamCount = 0;

export const SharedRefetchParamLoader = createLoader(async (ctx) => {
  sharedRefetchParamCount++;
  const tag = ctx.params.tag ?? "default";
  return { tag, count: sharedRefetchParamCount };
}, true);

// Failing loader for the error-throw-scope guard. Registered on the
// route so contextData is populated (required for the load() refetch
// to go through the shared store post-fix). The first call (route SSR)
// succeeds; subsequent calls — i.e. client refetches — throw. A
// per-loader counter avoids cross-test interference in production
// where the test-app preview server is shared.
let sharedRefetchErrorCount = 0;

export const SharedRefetchErrorLoader = createLoader(async () => {
  sharedRefetchErrorCount++;
  if (sharedRefetchErrorCount === 1) {
    return { ok: true } as const;
  }
  throw new Error("shared-refetch-error: refetch failed by design");
}, true);

// Mixed-throwOnError variant: same SSR-success / refetch-fail behavior,
// own counter so the two error-scenario tests don't share fail-state.
let sharedRefetchErrorMixedCount = 0;

export const SharedRefetchErrorMixedLoader = createLoader(async () => {
  sharedRefetchErrorMixedCount++;
  if (sharedRefetchErrorMixedCount === 1) {
    return { ok: true } as const;
  }
  throw new Error("shared-refetch-error-mixed: refetch failed by design");
}, true);
