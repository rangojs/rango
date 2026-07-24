import { createLoader } from "@rangojs/router";

export const ClientUrlsItemLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return `client-urls-item:${ctx.params.itemId}`;
});
