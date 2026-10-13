import { createHandle, createLoader } from "@rangojs/router";
import { countClientLayoutRun, getClientLayoutCart } from "./store.js";

/** The group layout's own loader (urls.tsx). */
export const ClientLayoutCartLoader = createLoader(
  async () => `cart:${getClientLayoutCart()}`,
);

export const ClientLayoutItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.id}`,
);

/** The crumbs the layout's runs loader pushes. */
export const ClientLayoutCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

/**
 * A layout() loader with no revalidate(): a layout's default holds it on every
 * navigation and re-runs it on an action. It takes 300 ms and pushes a crumb.
 */
export const ClientLayoutRunsLoader = createLoader(async (ctx) => {
  const runs = countClientLayoutRun();
  ctx.use(ClientLayoutCrumbs)(`runs:${runs}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return `runs:${runs}`;
});
