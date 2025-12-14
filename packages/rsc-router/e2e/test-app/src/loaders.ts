import { createLoader } from "rsc-router/loader";

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
