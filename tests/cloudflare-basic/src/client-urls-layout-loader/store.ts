/** Cart count of the layout-loader group: the action bumps it, the layout's
 *  loader reads it (urls.tsx). */
let cart = 0;

export function getClientLayoutCart(): number {
  return cart;
}

export function bumpClientLayoutCartCount(): void {
  cart += 1;
}

/** Runs of the layout's runs loader. */
let runs = 0;

export function countClientLayoutRun(): number {
  runs += 1;
  return runs;
}
