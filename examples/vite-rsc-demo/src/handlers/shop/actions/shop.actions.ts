'use server'

/**
 * Shop Actions - Server-side mutations
 *
 * These actions demonstrate React Server Actions in the RSC router:
 * - Use 'use server' directive for automatic action registration
 * - Mutations happen server-side (in-memory for demo, use DB in production)
 * - No return values needed - revalidation triggers UI updates
 * - Actions are serialized and can be passed to client components
 */

// Simple in-memory cart for demo (replace with database in real app)
const carts = new Map<string, { items: Array<{ productId: string; quantity: number }> }>();

/**
 * Add item to shopping cart
 *
 * @param productId - Product identifier (e.g., "wireless-headphones")
 * @param quantity - Number of items to add (default: 1)
 */
export async function addToCart(productId: string, quantity: number = 1) {
  console.log(`[Action] addToCart: ${productId} x${quantity}`);

  // Get or create cart (in real app: get from session/user context)
  const cartId = 'demo-cart';
  let cart = carts.get(cartId);

  if (!cart) {
    cart = { items: [] };
    carts.set(cartId, cart);
  }

  // Add or update item
  const existing = cart.items.find(item => item.productId === productId);
  if (existing) {
    existing.quantity += quantity;
    console.log(`[Action] Updated existing item: ${productId} (now ${existing.quantity})`);
  } else {
    cart.items.push({ productId, quantity });
    console.log(`[Action] Added new item: ${productId} x${quantity}`);
  }

  console.log(`[Action] Cart updated:`, cart);

  // No return value needed - revalidation will update the UI
}

/**
 * Remove item from shopping cart
 *
 * @param productId - Product identifier to remove
 */
export async function removeFromCart(productId: string) {
  console.log(`[Action] removeFromCart: ${productId}`);

  const cartId = 'demo-cart';
  const cart = carts.get(cartId);

  if (cart) {
    cart.items = cart.items.filter(item => item.productId !== productId);
    console.log(`[Action] Removed ${productId}, cart now has ${cart.items.length} items`);
  }
}

/**
 * Clear all items from cart
 */
export async function clearCart() {
  console.log(`[Action] clearCart`);

  const cartId = 'demo-cart';
  const cart = carts.get(cartId);

  if (cart) {
    cart.items = [];
    console.log(`[Action] Cart cleared`);
  }
}

/**
 * Get current cart item count (for display)
 * This is not an action - just a helper function
 *
 * @returns Total number of items in cart
 */
export async function getCartCount(): Promise<number> {
  const cart = carts.get('demo-cart');
  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) || 0;
  console.log(`[Action] getCartCount: ${count}`);
  return count;
}

/**
 * Get cart items (for display)
 * This is not an action - just a helper function
 *
 * @returns Array of cart items
 */
export async function getCartItems(): Promise<Array<{ productId: string; quantity: number }>> {
  const cart = carts.get('demo-cart');
  return cart?.items || [];
}

/**
 * Add to cart with validation and return value
 * Demonstrates action that returns data to the client
 *
 * @param productId - Product identifier
 * @param quantity - Number to add
 * @returns Success status and cart summary
 */
export async function addToCartWithResult(productId: string, quantity: number = 1) {
  console.log(`[Action] addToCartWithResult: ${productId} x${quantity}`);

  // Validate quantity
  if (quantity < 1) {
    console.log(`[Action] Validation failed: quantity must be positive`);
    throw new Error('Quantity must be at least 1');
  }

  if (quantity > 10) {
    console.log(`[Action] Validation failed: quantity too large`);
    throw new Error('Cannot add more than 10 items at once');
  }

  // Get or create cart
  const cartId = 'demo-cart';
  let cart = carts.get(cartId);

  if (!cart) {
    cart = { items: [] };
    carts.set(cartId, cart);
  }

  // Add or update item
  const existing = cart.items.find(item => item.productId === productId);
  const previousQuantity = existing?.quantity || 0;

  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  const newQuantity = existing?.quantity || quantity;
  const totalItems = cart.items.reduce((sum, item) => sum + item.quantity, 0);

  console.log(`[Action] Cart updated. Total items: ${totalItems}`);

  // Return success with cart summary
  return {
    success: true,
    message: `Added ${quantity} item(s) to cart`,
    cart: {
      productId,
      previousQuantity,
      newQuantity,
      totalItems,
    },
  };
}
