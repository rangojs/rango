/**
 * live() — the deterministic PPR hole primitive (docs/design/ppr-shell-resume.md).
 *
 * A PPR shell is captured by masking loaders and freezing everything that
 * settles synchronously or on a microtask into the shared prelude. That freeze
 * has a sharp edge: a value that is ALREADY resolved — `Promise.resolve(x)`, an
 * in-memory lookup, a cached read — settles during the capture's quiet window
 * and gets baked into the shell, served to every user of the URL. That is
 * usually what you want (deterministic content belongs in the shell), but not
 * when the value is per-request. `live()` is the escape hatch: it makes its
 * boundary a deterministic HOLE regardless of how fast the data resolves, so the
 * capture postpones there and the resumed serve pass streams the fresh value in.
 *
 * It is the userland analogue of the loader mask (loader-mask.ts): during the
 * background shell-capture render `live()` returns a never-settling promise so
 * the consuming Suspense subtree suspends and React's static prerender postpones
 * it. Outside capture — the ordinary serve pass, and the client — it is a
 * passthrough: the thunk runs, or the promise passes through unchanged.
 *
 * Two forms:
 *
 *   // Thunk (preferred): during capture the fn NEVER runs — no fetch, no cost.
 *   const price = await live(() => fetchPrice());
 *
 *   // Value: the work already fired before live() saw it, so during capture the
 *   // real promise is discarded and a hole is returned in its place. Use the
 *   // thunk form unless you already hold the promise.
 *   const price = await live(pricePromise);
 *
 * The consumer story in one line: a hole even when the data is already resolved —
 *   const x = await live(() => Promise.resolve(value)); // postpones under capture
 *
 * @see docs/design/ppr-shell-resume.md ("The live() hole primitive")
 */

import { _getRequestContext } from "./request-context.js";
import { isInsideCacheScope } from "./context.js";
import { INSIDE_CACHE_EXEC } from "../cache/taint.js";

/**
 * A promise that never settles — the capture-time hole. Same mechanism and
 * lifecycle as the loader mask (loader-mask.ts createMaskedLoaderPromise): the
 * consuming Suspense subtree suspends forever, so the static prerender postpones
 * it as a hole instead of baking a per-request value into the shared shell.
 * Nothing awaits it to settle — the capture aborts fizz to freeze the prelude
 * (maxWaitMs in captureShellHTML bounds that), and workerd/GC reclaims the
 * pending promise when the capture render tree is dropped. Kept never-settling
 * (not reject-on-abort) deliberately, to stay identical to the loader mask: a
 * capture-scoped reject signal would buy no capture-behavior difference, since
 * the abort — not the hole promise — is what ends the render.
 */
function captureHole<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** True only inside the background shell-capture render (shell-capture.ts sets
 * `_shellCaptureRun` on its derived context). Non-throwing: outside any request
 * context this is simply false, so live() passes through. */
function isShellCaptureActive(): boolean {
  return _getRequestContext()?._shellCaptureRun === true;
}

/**
 * Mark a Suspense boundary as a deterministic PPR hole (see the module doc).
 *
 * @param fn - Thunk producing the live value. During shell capture it is NOT
 *   invoked (no side effects, no cost); a never-settling promise is returned so
 *   the boundary postpones. Outside capture it runs and its result is returned
 *   as a promise.
 */
export function live<T>(fn: () => Promise<T> | T): Promise<T>;
/**
 * @param promise - A promise whose work has already fired. During shell capture
 *   the promise is discarded and a hole is returned in its place (the work still
 *   ran — prefer the thunk form to avoid that). Outside capture the promise
 *   passes through unchanged.
 */
export function live<T>(promise: Promise<T>): Promise<T>;
export function live<T>(
  input: (() => Promise<T> | T) | Promise<T>,
): Promise<T> {
  assertNotInsideCacheBoundary();
  if (isShellCaptureActive()) {
    return captureHole<T>();
  }
  return typeof input === "function"
    ? Promise.resolve((input as () => Promise<T> | T)())
    : input;
}

/**
 * Throw when live() is called inside a cache boundary — a "use cache" function
 * (INSIDE_CACHE_EXEC stamped on the request context) or a cache() DSL scope.
 *
 * live() only masks during the SHELL capture (ring 4). The inner cache rings
 * freeze first: a cache()/prerender write deep-settles the promise and stores
 * its VALUE in the segment cache, and the handler never re-runs on replay — so
 * a live() there is silently inert, and if the value is per-request it is the
 * same shared-cache leak cookies()/headers() guard against, defeated by the
 * very primitive the caller believed made it safe. A "use cache" miss during a
 * capture render is worse: the fn body runs under the capture flag, live()
 * returns a never-settling promise, and the cache write wedges awaiting it.
 * Same guard shape as assertNotInsideCacheContext in cookie-store.ts.
 */
function assertNotInsideCacheBoundary(): void {
  const ctx = _getRequestContext();
  if (
    ctx !== null &&
    ctx !== undefined &&
    (INSIDE_CACHE_EXEC as symbol) in (ctx as unknown as Record<symbol, unknown>)
  ) {
    throw new Error(
      `live() cannot be called inside a "use cache" function. The cached ` +
        `function's value is stored and replayed, so nothing inside it can ` +
        `stay live — and per-request data would be frozen into a shared ` +
        `cache entry. Read live data in a loader instead (loaders are never ` +
        `cached), or move the live() call outside the cached function.`,
    );
  }
  if (isInsideCacheScope()) {
    throw new Error(
      `live() cannot be called inside a cache() boundary. The segment cache ` +
        `deep-settles and stores the resolved VALUE at write time, and the ` +
        `handler never re-runs on a cache hit — so live() cannot keep this ` +
        `value live, and per-request data would be frozen into the shared ` +
        `cached segments. Use a loader behind loading() instead: loaders are ` +
        `the live lane through every cache ring.`,
    );
  }
}
