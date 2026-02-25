import { createLoader } from "@rangojs/router";

// Simple loader for prerender client component tests
export const PrerenderTestLoader = createLoader(async () => {
  return { test: true, message: "prerender-loader-data" };
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
  // Import dynamically to avoid "use server" directive issues
  const { getCartQuantity } = await import("./actions.jsx");
  const quantity = await getCartQuantity(productId);
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
