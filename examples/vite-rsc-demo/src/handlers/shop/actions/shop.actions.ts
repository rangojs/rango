"use server";

import { getRequestContext } from "@rangojs/router";

/**
 * Shop Actions - Server-side mutations
 *
 * These actions demonstrate React Server Actions in the RSC router:
 * - Use 'use server' directive for automatic action registration
 * - Mutations happen server-side with cookie-based cart ID for test isolation
 * - No return values needed - revalidation triggers UI updates
 * - Actions are serialized and can be passed to client components
 */

// Cart type definition
type Cart = { items: Array<{ productId: string; quantity: number }> };

const CART_ID_COOKIE_NAME = "shop-cart-id";

// In-memory cart storage keyed by cart ID for rapid updates
// Cookie stores the cart ID, not the cart data
const carts = new Map<string, Cart>();

// Generate a unique cart ID
function generateCartId(): string {
  return `cart-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Helper to get or create cart ID from cookie
function getOrCreateCartId(): string {
  const ctx = getRequestContext();
  if (!ctx) {
    return "demo-cart"; // Fallback for non-request context
  }

  const cookies = ctx.cookies();
  let cartId = cookies[CART_ID_COOKIE_NAME];

  if (!cartId) {
    cartId = generateCartId();
    ctx.setCookie(CART_ID_COOKIE_NAME, cartId, {
      path: "/",
      httpOnly: false,
      maxAge: 60 * 60 * 24, // 24 hours
    });
    console.log(`[Cart] Created new cart ID: ${cartId}`);
  }

  return cartId;
}

// Helper to get cart by ID
function getCartById(cartId: string): Cart {
  let cart = carts.get(cartId);
  if (!cart) {
    cart = { items: [] };
    carts.set(cartId, cart);
  }
  return cart;
}

export const getCart = async () => {
  const cartId = getOrCreateCartId();
  return getCartById(cartId);
};

/**
 * Add item to shopping cart
 *
 * @param productId - Product identifier (e.g., "wireless-headphones")
 * @param quantity - Number of items to add (default: 1)
 */
export async function addToCart(productId: string, quantity: number = 1) {
  console.log(`[Action] addToCart: ${productId} x${quantity}`);

  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);

  // Add or update item
  const existing = cart.items.find((item) => item.productId === productId);
  if (existing) {
    existing.quantity += quantity;
    console.log(
      `[Action] Updated existing item: ${productId} (now ${existing.quantity})`
    );
  } else {
    cart.items.push({ productId, quantity });
    console.log(`[Action] Added new item: ${productId} x${quantity}`);
  }

  console.log(`[Action] Cart ${cartId} updated:`, cart);

  // No return value needed - revalidation will update the UI
}

/**
 * Remove item from shopping cart
 *
 * @param productId - Product identifier to remove
 */
export async function removeFromCart(productId: string) {
  console.log(`[Action] removeFromCart: ${productId}`);

  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);

  cart.items = cart.items.filter((item) => item.productId !== productId);

  console.log(
    `[Action] Removed ${productId}, cart ${cartId} now has ${cart.items.length} items`
  );
}

/**
 * Update cart item quantity (increment/decrement)
 * Removes item if quantity becomes 0 or less
 *
 * @param productId - Product identifier
 * @param delta - Amount to change quantity by (+1 or -1 typically)
 * @returns New quantity (0 if removed)
 */
export async function updateCartQuantity(
  productId: string,
  delta: number
): Promise<number> {
  await delay(1000); // Simulate network delay
  console.log(`[Action] updateCartQuantity: ${productId} delta=${delta}`);

  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);

  const existing = cart.items.find((item) => item.productId === productId);

  if (existing) {
    existing.quantity += delta;

    if (existing.quantity <= 0) {
      // Remove item from cart
      cart.items = cart.items.filter((item) => item.productId !== productId);
      console.log(`[Action] Removed ${productId} from cart ${cartId} (quantity <= 0)`);
      return 0;
    }

    console.log(
      `[Action] Updated ${productId} quantity to ${existing.quantity} in cart ${cartId}`
    );
    return existing.quantity;
  } else if (delta > 0) {
    // Item not in cart, add it
    cart.items.push({ productId, quantity: delta });
    console.log(`[Action] Added new item ${productId} with quantity ${delta} to cart ${cartId}`);
    return delta;
  }

  return 0;
}

/**
 * Clear all items from cart
 */
export async function clearCart() {
  console.log(`[Action] clearCart`);

  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);
  cart.items = [];

  console.log(`[Action] Cart ${cartId} cleared`);
}

/**
 * Get current cart item count (for display)
 * This is not an action - just a helper function
 *
 * @returns Total number of items in cart
 */
export async function getCartCount(): Promise<number> {
  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  console.log(`[Action] getCartCount for ${cartId}: ${count}`);
  return count;
}

/**
 * Get cart items (for display)
 * This is not an action - just a helper function
 *
 * @returns Array of cart items
 */
export async function getCartItems(): Promise<
  Array<{ productId: string; quantity: number }>
> {
  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);
  return cart.items;
}

// Helper function for delay
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add to cart with validation and return value
 * Demonstrates action that returns data to the client
 *
 * @param productId - Product identifier
 * @param quantity - Number to add
 * @returns Success status and cart summary
 */
export async function addToCartWithResult(
  productId: string,
  quantity: number = 1
) {
  console.log(`[Action] addToCartWithResult: ${productId} x${quantity}`);

  // Artificial 3 second delay to demonstrate streaming/loading states
  console.log(`[Action] Simulating 3 second delay...`);
  console.log(`[Action] Delay complete, processing...`);

  // Validate quantity
  if (quantity < 1) {
    console.log(`[Action] Validation failed: quantity must be positive`);
    throw new Error("Quantity must be at least 1");
  }

  if (quantity > 10) {
    console.log(`[Action] Validation failed: quantity too large`);
    throw new Error("Cannot add more than 10 items at once");
  }

  const cartId = getOrCreateCartId();
  const cart = getCartById(cartId);

  // Add or update item
  const existing = cart.items.find((item) => item.productId === productId);
  const previousQuantity = existing?.quantity || 0;

  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  const newQuantity = existing?.quantity || quantity;
  const totalItems = cart.items.reduce((sum, item) => sum + item.quantity, 0);

  console.log(`[Action] Cart ${cartId} updated. Total items: ${totalItems}`);
  await delay(3000);

  // Return success with cart summary
  return {
    success: true,
    message: `Added[${productId}] ${quantity} item(s) to cart`,
    cart: {
      productId,
      previousQuantity,
      newQuantity,
      totalItems,
    },
  };
}
