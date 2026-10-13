import { createLoader } from "@rangojs/router";

/** The item route's loader (client-urls-locale.tsx). */
export const ClientLocaleItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.locale ?? "-"}:${ctx.params.itemId}`,
);
