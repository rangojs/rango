import type { ReactNode } from "react";
import { createElement } from "react";
import { isLoaderDataResult } from "./types.js";
import { LoaderRedirect } from "./loader-redirect.js";

/**
 * Markers for loader-thrown AUTHORITY SIGNALS (notFound()/redirect()) on the
 * reconstructed read-site error. Siblings of LOADER_ERROR_FALLBACK, routed
 * differently by StreamedLoaderErrorBoundary: NOT_FOUND renders the
 * server-rendered not-found UI riding the envelope; REDIRECT triggers a
 * client replace-navigation to the (server-resolved, same-origin-guarded)
 * target. Signals are control flow, not failures — they take precedence over
 * the plain error-fallback path.
 *
 * Only decodeLoaderEntry (the read-site path — client components, so the
 * throw lands in the router-owned boundary; during document SSR, Fizz emits
 * the Suspense fallback and replays the throw at hydration) throws these.
 * decodeLoaderResults runs during the SERVER tree build on forceAwait/action
 * lanes, where a throw would collapse the whole payload — it routes signals
 * through the errorFallback slot instead (same visual: the slot replaces the
 * children under OutletProvider).
 */
export const LOADER_NOT_FOUND_FALLBACK: unique symbol = Symbol(
  "rango.loaderNotFound",
);
export const LOADER_REDIRECT: unique symbol = Symbol("rango.loaderRedirect");

function throwSignal(result: any): void {
  if (result.notFound === true) {
    const err = new Error(result.error?.message ?? "Not found");
    err.name = result.error?.name ?? "DataNotFoundError";
    (err as any)[LOADER_NOT_FOUND_FALLBACK] = result.fallback ?? null;
    throw err;
  }
  if (result.redirect) {
    const err = new Error(result.error?.message ?? "Loader redirect");
    err.name = "LoaderRedirect";
    (err as any)[LOADER_REDIRECT] = result.redirect;
    throw err;
  }
}

/**
 * Non-throwing signal resolution for the aggregate path. Returns the node to
 * place in the errorFallback slot, or undefined when the result carries no
 * signal.
 */
function signalFallback(result: any): ReactNode | undefined {
  if (result.notFound === true) {
    return (result.fallback ?? null) as ReactNode;
  }
  if (result.redirect) {
    const redirect = result.redirect as {
      to: string;
      state?: Record<string, unknown>;
    };
    return createElement(LoaderRedirect, {
      to: redirect.to,
      state: redirect.state,
    });
  }
  return undefined;
}

// Shared by segment-system (server) and LoaderResolver (client) so the
// legacy/ok/error-fallback/throw decode of resolved loader values lives once.
// Last failing loader wins errorFallback; an error without a fallback throws.
export function decodeLoaderResults(
  resolvedData: any[],
  loaderIds: string[],
): { loaderData: Record<string, any>; errorFallback: ReactNode } {
  const loaderData: Record<string, any> = {};
  let errorFallback: ReactNode = null;

  for (let i = 0; i < loaderIds.length; i++) {
    const id = loaderIds[i];
    const result = resolvedData[i];

    if (!isLoaderDataResult(result)) {
      loaderData[id] = result;
      continue;
    }

    if (result.ok) {
      loaderData[id] = result.data;
      continue;
    }

    // Authority signals take the errorFallback slot (this decode runs during
    // the server tree build on forceAwait/action lanes — throwing here would
    // collapse the payload). A signal outranks a plain error fallback and
    // stops the scan: notFound renders the server-rendered 404 UI, redirect
    // mounts LoaderRedirect which navigates.
    const signal = signalFallback(result);
    if (signal !== undefined) {
      return { loaderData, errorFallback: signal };
    }

    // null/undefined is the producer's ONLY "no boundary found" sentinel
    // (loader-resolution.ts sets fallback: null for the no-boundary and the
    // fallback-render-threw cases). A matched boundary's rendered ReactNode can
    // legitimately be falsy (0, "", false), so test for null explicitly rather
    // than truthiness, otherwise a valid falsy fallback is discarded and the
    // original loader error is rethrown.
    if (result.fallback != null) {
      errorFallback = result.fallback;
    } else {
      // No boundary: rethrow preserving the ErrorInfo identity (name/stack/
      // code/cause) instead of a stripped generic Error.
      const info = result.error;
      const err = new Error(
        info.message,
        info.cause !== undefined ? { cause: info.cause } : undefined,
      );
      if (info.name) err.name = info.name;
      if (info.stack) err.stack = info.stack;
      if (info.code !== undefined) (err as { code?: string }).code = info.code;
      throw err;
    }
  }

  return { loaderData, errorFallback };
}

/**
 * Marker property carrying the errorBoundary() fallback on a read-site loader
 * error. decodeLoaderEntry attaches the pre-rendered boundary node (produced
 * server-side by loader-resolution) to the thrown error; the router-owned
 * StreamedLoaderErrorBoundary above the readers (segment-system wires it for
 * every loader-bearing segment) catches by this marker and renders the
 * fallback — restoring the build-time errorFallback-swap contract for
 * streamed loaders. Errors without the marker rethrow to the app's boundaries.
 */
export const LOADER_ERROR_FALLBACK: unique symbol = Symbol(
  "rango.loaderErrorFallback",
);

/**
 * Streaming useLoader: single-entry decode for read-site resolution. Mirrors
 * decodeLoaderResults for one result. An error entry throws the reconstructed
 * error (name/stack/code/cause preserved); when the entry carries an
 * errorBoundary() fallback, the node rides the throw via
 * LOADER_ERROR_FALLBACK for the boundary above the readers to render.
 */
export function decodeLoaderEntry(result: any): any {
  if (!isLoaderDataResult(result)) {
    return result;
  }
  if (result.ok) {
    return result.data;
  }
  throwSignal(result);
  const info = result.error;
  const err = new Error(
    info.message,
    info.cause !== undefined ? { cause: info.cause } : undefined,
  );
  if (info.name) err.name = info.name;
  if (info.stack) err.stack = info.stack;
  if (info.code !== undefined) (err as { code?: string }).code = info.code;
  if (result.fallback != null) {
    (err as any)[LOADER_ERROR_FALLBACK] = result.fallback;
  }
  throw err;
}
