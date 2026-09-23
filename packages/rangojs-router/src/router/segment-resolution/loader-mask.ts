/**
 * PPR shell-capture loader masking.
 *
 * During a shell CAPTURE re-render (Axis 2, see docs/design/ppr-shell-resume.md)
 * live-lane loaders (lane rule: see resolveLoaderData, loader-cache.ts) must
 * NOT execute; their value slot gets a never-resolving promise so the
 * consuming Suspense subtree postpones as a hole, and the serve pass runs them
 * fresh into it.
 *
 * Capture mode is signalled by `requestCtx._shellCaptureRun`, set to true ONLY on
 * the derived request context of the background capture task (shell-capture.ts) —
 * NOT by the foreground render, whose `_shellCapture` descriptor merely means "a
 * capture is wanted" and must not change behavior. This module is the single home
 * for the mask so every loader execution site gates the same way (loader-cache.ts
 * `resolveLoaderData`, fresh.ts `resolveLoaders`).
 */

import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

/**
 * True when the current render is the active PPR shell capture and route loaders
 * must be masked rather than executed. Reads `_shellCaptureRun` off the ALS
 * request context (the capture task re-establishes its derived context via
 * runWithRequestContext), so it is accurate at the loader resolution sites, which
 * run synchronously inside the pipeline's context frame.
 */
export function isShellCaptureActive(
  reqCtx: RequestContext<any> | undefined = _getRequestContext(),
): boolean {
  return reqCtx?._shellCaptureRun === true;
}

// createMaskedLoaderPromise lives in the leaf module mask-nested.ts, beside
// maskNestedContainerThenables (also used by the capture handle-store push
// wrap in rsc/shell-capture.ts). Re-exported to keep the mask API in one place.
export { createMaskedLoaderPromise } from "./mask-nested.js";

/**
 * True when the entry's loading() is renderable (mirrors segment-system's
 * isRenderableLoading). Not the lane decision (lane rule: see
 * resolveLoaderData, loader-cache.ts): callers only use it to decide whether
 * an unflagged loader's segment key rides as the bake/seed key, which is inert
 * at capture.
 */
export function entryLoadingMasksLoaders(loading: unknown): boolean {
  return loading !== undefined && loading !== null && loading !== false;
}
