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

export async function cachedCrumb(
  ctx: HandlerContext,
  label: string,
): Promise<string> {
  "use cache";
  ctx.use(CachedCrumbs)(label);
  return label;
}
