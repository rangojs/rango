// "use cache" function for serve-shell-request-streamed-handle-owner.rsc-test.tsx
// (wrapped by rangoUseCacheTransform() in vitest.rsc.config.ts).
import {
  createHandle,
  type Handle,
  type HandlerContext,
} from "../../../index.rsc.js";

export const CachedCrumbs: Handle<string, string[]> = createHandle<
  string,
  string[]
>((segments) => segments.flat());

/** Runs of cachedCrumb's body: a HIT does not add one. */
export const cachedCrumbRuns = { count: 0 };

export async function cachedCrumb(
  ctx: HandlerContext<any>,
  label: string,
): Promise<string> {
  "use cache";
  cachedCrumbRuns.count++;
  ctx.use(CachedCrumbs)(label);
  return label;
}
