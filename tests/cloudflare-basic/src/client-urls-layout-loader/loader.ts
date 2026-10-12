import { createLoader } from "@rangojs/router";
import { getClientLayoutCart } from "./store.js";

/** The group layout's own loader (urls.tsx). */
export const ClientLayoutCartLoader = createLoader(
  async () => `cart:${getClientLayoutCart()}`,
);

export const ClientLayoutItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.id}`,
);
