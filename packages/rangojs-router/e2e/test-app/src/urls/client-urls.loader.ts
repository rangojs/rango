import { createLoader } from "@rangojs/router";
import { getClientUrlsActionCount } from "./client-urls-action.store.js";

export const ClientUrlsItemLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return `client-urls-item:${ctx.params.itemId}`;
});

export const ClientUrlsCounterLoader = createLoader(async () => {
  return `count:${getClientUrlsActionCount()}`;
});
