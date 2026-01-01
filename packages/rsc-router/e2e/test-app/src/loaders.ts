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
export const ProductsLoader = createLoader(
  "products",
  async () => {
    return { products, loadedAt: new Date().toISOString() };
  }
);

/**
 * Load single product by ID
 */
export const ProductDetailLoader = createLoader(
  "product-detail",
  async (ctx) => {
    const productId = ctx.params.productId;
    const product = products.find((p) => p.id === productId);
    if (!product) {
      throw new Error(`Product not found: ${productId}`);
    }
    return { product, loadedAt: new Date().toISOString() };
  }
);

/**
 * Load cart quantity for a product
 */
export const CartQuantityLoader = createLoader(
  "cart-quantity",
  async (ctx) => {
    const productId = ctx.params.productId;
    // Import dynamically to avoid "use server" directive issues
    const { getCartQuantity } = await import("./actions.jsx");
    const quantity = await getCartQuantity(productId);
    return { productId, quantity };
  }
);

// Counter to track loader invocations for revalidation testing
let slowLoaderCount = 0;

/**
 * Slow loader with 1s delay - used to test loading behavior
 * Tracks invocation count to verify revalidation
 */
export const SlowLoader = createLoader("slow-loader", async () => {
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
export const SlowProductDetailLoader = createLoader(
  "slow-product-detail",
  async (ctx) => {
    const productId = ctx.params.productId;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const product = slowProducts.find((p) => p.id === productId) || {
      id: productId,
      name: `Product ${productId}`,
      price: 99.99,
      description: "Dynamic slow loading product",
    };
    return { product, loadedAt: new Date().toISOString() };
  }
);

// Counter to track fetchable loader invocations
let fetchableLoaderCount = 0;

/**
 * Fetchable loader for testing useFetchLoader hook (GET-based loader fetching)
 * The third argument `true` makes this loader fetchable via GET requests
 */
export const FetchableTestLoader = createLoader(
  "fetchable-test",
  async (ctx) => {
    fetchableLoaderCount++;
    const id = ctx.params.id || "default";
    return {
      message: "Fetched via GET!",
      id,
      count: fetchableLoaderCount,
      timestamp: new Date().toISOString(),
    };
  },
  true // Enable fetchable (GET-based fetching)
);

