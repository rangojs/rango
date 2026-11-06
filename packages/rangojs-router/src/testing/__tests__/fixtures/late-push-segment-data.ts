// A "use cache" function that pushes a handle through the ctx it is given.
// rangoUseCacheTransform() (vitest.rsc.config.ts) wraps it with
// registerCachedFunction; a HIT replays the recorded push into the caller's
// segment.
import { createHandle, type Handle } from "../../../handle.js";
import type { HandlerContext } from "../../../types.js";

export const CachedCrumbs: Handle<string, string[]> = createHandle<
  string,
  string[]
>((segments) => segments.flat());

export async function pushCachedCrumb(ctx: HandlerContext): Promise<string> {
  "use cache";
  ctx.use(CachedCrumbs)("cached");
  return "cached";
}
