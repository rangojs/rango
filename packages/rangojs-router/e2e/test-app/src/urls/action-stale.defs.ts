import { createLoader } from "@rangojs/router";
import { actionStaleState, wait } from "./action-stale.store.js";

// Loaders only, so the client build gets id stubs for this module.

/** The layout's cart count: reads the cart after a 300 ms server delay. */
export const ActionStaleCartLoader = createLoader(async () => {
  await wait(300);
  const state = actionStaleState();
  state.cartRuns += 1;
  return { cart: state.cart, runs: state.cartRuns };
});

/** A layout loader with no revalidate(): its default holds it on navigation. */
export const ActionStalePlainLoader = createLoader(async () => {
  const state = actionStaleState();
  state.plainRuns += 1;
  return state.plainRuns;
});
