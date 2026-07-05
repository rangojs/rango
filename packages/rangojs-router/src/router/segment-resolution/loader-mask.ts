/**
 * PPR shell-capture loader masking.
 *
 * During a shell CAPTURE re-render (Axis 2, see docs/design/ppr-shell-resume.md)
 * route loaders are the "live lane": they must NOT execute — no side effects, no
 * cost, no cache round-trips. Instead every loader segment's value slot receives
 * a never-resolving promise, so the loader-consuming Suspense subtree stays
 * pending and React's static `prerender` marks it as a postponed hole. The frozen
 * shell (prelude) captures only the fallback; the resumed serve pass runs the
 * loaders fresh through the unchanged execution path and streams their output
 * into the holes.
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

// createMaskedLoaderPromise moved to the leaf module mask-nested.ts (shared
// with the handle-push funnel in request-context, which cannot import THIS
// module without a cycle). Re-exported to keep the mask API in one place.
export { createMaskedLoaderPromise } from "./mask-nested.js";

/**
 * Lane decision for an entry's loaders under PPR (the loading() value decides;
 * docs/design/loader-container-bake.md):
 *
 * - RENDERABLE loading() (the LoaderBoundary Suspense fallback) — the LIVE
 *   lane: masked at capture, guaranteed fresh on every serve. Returns true.
 * - No loading() (absent, or explicitly `false`, incl. `loading(x, { ssr:
 *   false })` under the SSR manifest) — the BAKE lane: the loader executes
 *   during capture, its settled container bakes, nested pending promises hole
 *   at the consumer's own Suspense. Returns false.
 *
 * Mirrors segment-system's isRenderableLoading so the mask decision and the
 * tree's boundary placement can never disagree.
 */
export function entryLoadingMasksLoaders(loading: unknown): boolean {
  return loading !== undefined && loading !== null && loading !== false;
}
