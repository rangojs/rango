import { createLoader } from "@rangojs/router";

/**
 * Loader for the same-route stale-while-revalidate / morph navigation test
 * (/swr-product/:id). A deterministic delay means a remount would show the
 * route's loading skeleton, so the "no skeleton flash on same-route nav"
 * assertion is meaningful. loadedAt distinguishes one resolution from the next.
 */
export const SwrProductLoader = createLoader(async (ctx) => {
  const id = ctx.params.id as string;
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { id, name: `Product ${id}`, loadedAt: new Date().toISOString() };
});
