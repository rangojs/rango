import { createLoader } from "@rangojs/router";
import { getClientUrlsActionCount } from "./client-urls-action.store.js";

export const ClientUrlsItemLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return `client-urls-item:${ctx.params.itemId}`;
});

export const ClientUrlsCounterLoader = createLoader(async () => {
  return `count:${getClientUrlsActionCount()}`;
});

/**
 * Distinct $$id reading the SAME counter — its client-run revalidate() skips
 * action revalidation, so after an action this value diverges from
 * ClientUrlsCounterLoader in the same commit (per-loader decisions, not a
 * route-level batch).
 */
export const ClientUrlsSessionLoader = createLoader(async () => {
  return `session:${getClientUrlsActionCount()}`;
});
