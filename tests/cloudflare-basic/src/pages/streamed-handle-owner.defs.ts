import { Breadcrumbs, createLoader } from "@rangojs/router";
import type { AppBindings } from "../env.js";

// e2e streamed-handle-owner.test.ts. Every push in this fixture follows real
// workerd I/O: a KV read, a dynamic import and a timer, the awaits that can
// drop an AsyncLocalStorage store there (cache-lookup.ts).
export async function shoIo(env: Pick<AppBindings, "KV">): Promise<void> {
  await env.KV.get("streamed-handle-owner");
  await import("./streamed-handle-owner.lazy.js");
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Pushes "Inner"; ShoOuterLoader's body starts it after its I/O. */
export const ShoInnerLoader = createLoader(async (ctx) => {
  ctx.use(Breadcrumbs)({
    label: "Inner",
    href: "/streamed-handle-owner/loader#inner",
  });
  return null;
});

/** A route's loader() that starts ShoInnerLoader after its I/O. */
export const ShoOuterLoader = createLoader(async (ctx) => {
  await shoIo(ctx.env);
  await ctx.use(ShoInnerLoader);
  return null;
});
