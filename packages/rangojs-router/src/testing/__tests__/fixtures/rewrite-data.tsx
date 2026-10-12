// "use cache" function for rewrite.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). A handler ctx argument
// keys the entry by route and URL only, so the visitor's URL of a rewritten
// request is not in the key: reading it inside the body throws.
import type { HandlerContext } from "../../../index.rsc.js";

export async function cachedRewrittenFrom(
  ctx: HandlerContext,
): Promise<string> {
  "use cache";
  return `uc from=${ctx.rewrittenFrom?.pathname ?? "direct"}`;
}
