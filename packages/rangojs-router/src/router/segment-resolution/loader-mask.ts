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

import { _getRequestContext } from "../../server/request-context.js";

/**
 * True when the current render is the active PPR shell capture and route loaders
 * must be masked rather than executed. Reads `_shellCaptureRun` off the ALS
 * request context (the capture task re-establishes its derived context via
 * runWithRequestContext), so it is accurate at the loader resolution sites, which
 * run synchronously inside the pipeline's context frame.
 */
export function isShellCaptureActive(): boolean {
  return _getRequestContext()?._shellCaptureRun === true;
}

/**
 * A promise that never settles — the masked stand-in for a loader's value during
 * shell capture. The consuming Suspense subtree suspends forever, so the static
 * prerender postpones it as a hole instead of baking a per-request value into the
 * shared shell. The capture abort (`maxWaitMs` in captureShellHTML) bounds how
 * long the prerender waits before it freezes the prelude, so this never hangs the
 * request.
 */
export function createMaskedLoaderPromise<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}
