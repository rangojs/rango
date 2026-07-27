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

let stampCounter = 0;

/**
 * Fetchable loader for the group hooks probe: useFetchLoader() addresses it
 * by id through the loader endpoint — a lane with no route/group mechanics
 * at all, so it works inside clientUrls exactly as anywhere else. The
 * monotonic counter makes consecutive load() calls observably distinct.
 */
export const ClientUrlsStampLoader = createLoader(async () => {
  stampCounter += 1;
  return `stamp:${stampCounter}`;
}, true);
