import { createLoader } from "@rangojs/router";
import { getClientLayoutCart } from "./client-urls-layout-loader.store.js";

/** The group layout's own loader (client-urls-layout-loader.tsx). */
export const ClientLayoutCartLoader = createLoader(
  async () => `cart:${getClientLayoutCart()}`,
);

export const ClientLayoutItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.id}`,
);
