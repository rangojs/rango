/** Cart count of the layout-loader group: the action bumps it, the layout's
 *  loader reads it (client-urls-layout-loader.tsx). */
let cart = 0;

export function getClientLayoutCart(): number {
  return cart;
}

export function bumpClientLayoutCartCount(): void {
  cart += 1;
}
