// "use cache" function for reverse-segment-scope.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts).
import type { HandlerContext } from "../../../index.rsc.js";

export async function cachedSettingsLink(ctx: HandlerContext): Promise<string> {
  "use cache";
  return (ctx.reverse as (name: string) => string)(".settings");
}
