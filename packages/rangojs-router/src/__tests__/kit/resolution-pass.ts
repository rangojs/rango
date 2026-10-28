import {
  freshPassInput,
  type ResolutionPass,
} from "../../router/segment-resolution/resolution-pass.js";
import type { SegmentResolutionDeps } from "../../router/types.js";
import type { HandlerContext, InternalHandlerContext } from "../../types.js";

interface KitFreshPassOptions {
  /** Defaults to the context's `_routeName`, else "test". */
  routeKey?: string;
  /** Defaults to the context's params. */
  params?: Record<string, string>;
  skipLoaders?: boolean;
  throwOnError?: boolean;
}

/**
 * A full match's ResolutionPass: freshPassInput (resolution-pass.ts), the
 * input match middleware builds for a document, with `deps` bound as
 * createSegmentWrappers (segment-wrappers.ts) binds the router's.
 */
export function makeFreshPass<TEnv = any>(
  context: HandlerContext<any, TEnv>,
  deps: SegmentResolutionDeps<TEnv>,
  options: KitFreshPassOptions = {},
): ResolutionPass<TEnv> {
  const {
    routeKey = (context as InternalHandlerContext<any, TEnv>)._routeName ??
      "test",
    params = (context.params ?? {}) as Record<string, string>,
    ...flags
  } = options;
  return { ...freshPassInput(context, routeKey, params, flags), deps };
}
