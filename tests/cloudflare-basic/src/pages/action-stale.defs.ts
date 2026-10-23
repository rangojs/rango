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

/**
 * A layout loader with no revalidate() that reads the cart: a navigation
 * holds it, and a stale entry's revalidation skips it, so only a whole
 * refetch (an action's own response, or the follow-up) shows the write.
 */
export const ActionStaleCartDefaultLoader = createLoader(
  async () => actionStaleState().cart,
);

/** The item modal's cart read. */
export const ActionStaleItemLoader = createLoader(async () => {
  await wait(100);
  return actionStaleState().cart;
});

/**
 * The fill page's cart read, kept out of a prefetch (`prefetch: false`), after
 * ?fillDelay ms (default 300).
 */
export const ActionStaleFillLoader = createLoader(async (ctx) => {
  await wait(Number(ctx.searchParams.get("fillDelay") ?? 300));
  return actionStaleState().cart;
});
