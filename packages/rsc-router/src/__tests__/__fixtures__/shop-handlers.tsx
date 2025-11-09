/**
 * Shop handlers - Should ONLY load when /shop routes are accessed
 * Tracks loading via global flag
 */

import { route, map } from '../../route-definition';

// TRACKING: Set flag when this module loads
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__shopHandlersLoaded = true;
}

export const shopRoutes = route({
  products: '/shop',
  cart: '/shop/cart',
});

export default map(shopRoutes, {
  [route.layout]: () => <div>ShopLayout</div>,
  products: () => <div>Products</div>,
  cart: () => <div>Cart</div>,
});
