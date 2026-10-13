import { createLoader } from "@rangojs/router";

/** The item route's loader (client-urls-compete.tsx). */
export const ClientCompeteItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.itemId}`,
);
