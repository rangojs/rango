import { createLoader } from "rsc-router/server";

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
  const productId = ctx.params.productId;
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
  true // Enable fetchable (GET-based fetching)
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
  true // Fetchable - allows passing to client components
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
  true // Fetchable - allows passing to client components
);

/**
 * Fetchable loader for testing useFetchLoader on-demand fetching.
 * This loader is NOT registered on any route - used for client-side fetching only.
 */
export const UnregisteredLoader = createLoader(
  async (ctx) => {
    const id = ctx.params.id || "unregistered";
    return {
      id,
      message: "Fetched from unregistered loader",
      timestamp: new Date().toISOString(),
    };
  },
  true // Fetchable - for client-side load() calls
);

/**
 * Loader that throws an error - for testing error state handling
 */
export const ErrorLoader = createLoader(
  async (ctx) => {
    const shouldFail = ctx.params.shouldFail !== "false";
    if (shouldFail) {
      throw new Error("Intentional loader error for testing");
    }
    return {
      message: "Success - error was bypassed",
      timestamp: new Date().toISOString(),
    };
  },
  true
);

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
  }
);

