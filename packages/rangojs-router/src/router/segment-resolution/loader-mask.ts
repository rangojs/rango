/**
 * PPR shell-capture loader masking.
 *
 * During a shell CAPTURE re-render (Axis 2, see docs/design/ppr-shell-resume.md)
 * live-lane loaders (lane rule: see resolveLoaderData, loader-cache.ts) must
 * NOT execute; their value slot gets a never-resolving promise so the
 * consuming Suspense subtree postpones as a hole, and the serve pass runs them
 * fresh into it.
 *
 * Capture mode is signalled by `requestCtx._shellCaptureState.run`, set ONLY on
 * the derived request context of the background capture task (shell-capture.ts);
 * the foreground render never has it. This module is the single home for the
 * mask so every loader execution site gates the same way (loader-cache.ts
 * `resolveLoaderData`, revalidation.ts `resolveOwnerLoaders`).
 */

import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { isRenderableLoading } from "../../types/boundaries.js";

/**
 * True when the current render is the active PPR shell capture and route loaders
 * must be masked rather than executed. Reads `_shellCaptureState` off the ALS
 * request context (the capture task re-establishes its derived context via
 * runWithRequestContext), so it is accurate at the loader resolution sites, which
 * run synchronously inside the pipeline's context frame.
 */
export function isShellCaptureActive(
  reqCtx: RequestContext<any> | undefined = _getRequestContext(),
): boolean {
  return reqCtx?._shellCaptureState?.run === true;
}

// createMaskedLoaderPromise lives in the leaf module mask-nested.ts, beside
// maskNestedContainerThenables (also used by the capture handle-store push
// wrap in rsc/shell-capture.ts). Re-exported to keep the mask API in one place.
export { createMaskedLoaderPromise } from "./mask-nested.js";

/**
 * True when the entry's loading() is renderable (the shared
 * isRenderableLoading, types/boundaries.ts, that segment-system gates on).
 * Not the lane decision (lane rule: see
 * resolveLoaderData, loader-cache.ts): callers only use it to decide whether
 * an unflagged loader's segment key rides as the bake/seed key, which is inert
 * at capture.
 */
export function entryLoadingMasksLoaders(loading: unknown): boolean {
  return isRenderableLoading(loading);
}
