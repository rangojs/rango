import { createLoader } from "rsc-router";
import { orders } from "../data.js";

export type Order = {
  id: string;
  date: string;
  total: number;
  status: string;
};

/**
 * Orders Loader - fetches user's order history
 *
 * Used in account section to display order history.
 */
export const OrdersLoader = createLoader("orders", async (_ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 100));
  return orders;
});
