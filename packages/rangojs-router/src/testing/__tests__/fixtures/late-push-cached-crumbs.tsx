// A "use cache" function that takes a handler's ctx and pushes a handle, as an
// app writes it. rangoUseCacheTransform() (vitest.rsc.config.ts) wraps it with
// registerCachedFunction, so a second call reads the store.
import { createHandle, type Handle } from "../../../index.rsc.js";
import type { HandlerContext } from "../../../types/handler-context.js";

export const Crumbs: Handle<string, string[]> = createHandle<string, string[]>(
  (segments) => segments.flat(),
);

export const runs: { push: number } = { push: 0 };

export async function pushCachedCrumbs(
  ctx: HandlerContext,
  label: string,
): Promise<string> {
  "use cache";
  runs.push += 1;
  ctx.use(Crumbs)(label);
  return label;
}
