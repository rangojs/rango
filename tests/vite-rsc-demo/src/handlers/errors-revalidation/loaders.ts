import { createLoader } from "@rangojs/router";
import { saves, stockFailing } from "./state.js";

/** /errors/revalidation: a Save whose revalidation reruns a loader that throws. */

/** Throws while the switch is on: the read in the page throws in place. */
export const StockLoader = createLoader(async () => {
  if (stockFailing()) throw new Error("Stock service unavailable");
  const n = saves();
  return {
    asOfSave: n,
    items: [
      { sku: "A-1", name: "Wireless headphones", qty: 12 + n },
      { sku: "B-7", name: "Running shoes", qty: 4 + n },
    ],
  };
});

/**
 * Reruns with every action and never throws. Read outside the stock
 * boundary, it is that boundary's reset key and shows that the page's other
 * data committed while the stock read failed.
 */
export const SaveStatusLoader = createLoader(async () => ({ saves: saves() }));

/** The switch, for the layout's checkbox. */
export const StockFailureFlagLoader = createLoader(async () => ({
  failing: stockFailing(),
}));
