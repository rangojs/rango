/**
 * A `throw redirect(...)` raised INSIDE the Flight render (a server component),
 * not by a loader, handler or middleware.
 *
 * Every other redirect lane is caught by router code that owns the response
 * (a loader result marker, a handler's thrown Response, an action's outcome).
 * A component's throw is caught by React: Flight writes an error row and the
 * stream keeps going, so by the time the router learns of it the response may
 * already be committed (a client navigation, a document whose `<Suspense>`
 * shell flushed). The one field React lets the server fill in on that row is
 * the error digest (`onError`'s return value), and the client puts it back on
 * the decoded error (`error.digest`). So the redirect rides the digest:
 *
 * - `createFlightStage` (`rsc/render-pipeline.ts`) turns the thrown Response
 *   into this digest and skips the error report/print — control flow, not a
 *   failure, exactly as a loader's `redirect()` is.
 * - `answerShellError` (`ssr/shell-error-document.tsx`) answers a document
 *   whose shell fails on the row with the redirect's own 3xx (or the recovery
 *   document when it carries state), the same answer a loader redirect gets.
 * - `RootErrorBoundary` / `StreamedLoaderErrorBoundary` render `LoaderRedirect`
 *   when the caught error carries this digest, which is the only lane left once
 *   the response has started.
 *
 * Runtime-neutral (no server or client imports) so both halves read one shape.
 */

/** Prefix that marks a Flight error digest as a render-time redirect. */
export const RENDER_REDIRECT_DIGEST_PREFIX: string = "rango:redirect:";

/** A redirect thrown during the render, resolved for the wire. */
export interface RenderRedirect {
  /** Target after `prefixBasename` and the same-origin policy. */
  to: string;
  /** The thrown Response's own status. */
  status: number;
  /** `redirect(url, { external: true })` opt-in. */
  external?: boolean;
  /** Resolved `redirect(url, { state })` record. */
  state?: Record<string, unknown>;
}

/** The digest string Flight writes into the error row for a render redirect. */
export function renderRedirectDigest(redirect: RenderRedirect): string {
  return (
    RENDER_REDIRECT_DIGEST_PREFIX + encodeURIComponent(JSON.stringify(redirect))
  );
}

/**
 * Read a render redirect off a Flight-decoded error, or null for any other
 * error (an error row without our prefix, a non-error, a malformed payload).
 */
export function renderRedirectOf(error: unknown): RenderRedirect | null {
  if (typeof error !== "object" || error === null) return null;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") return null;
  if (!digest.startsWith(RENDER_REDIRECT_DIGEST_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(digest.slice(RENDER_REDIRECT_DIGEST_PREFIX.length)),
    ) as Partial<RenderRedirect> | null;
    if (typeof parsed?.to !== "string" || typeof parsed.status !== "number") {
      return null;
    }
    return {
      to: parsed.to,
      status: parsed.status,
      ...(parsed.external === true && { external: true }),
      ...(parsed.state && { state: parsed.state }),
    };
  } catch {
    return null;
  }
}
