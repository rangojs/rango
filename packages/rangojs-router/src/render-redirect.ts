/**
 * A `redirect()` thrown while React serializes the payload: an async server
 * component (or anything else Flight renders) that throws the Response after
 * the handler returned. No router catch sees it: the handler already
 * returned, so the throw surfaces in Flight's onError, after the status line
 * may have gone out. It travels as the error row's `digest`, the one field of
 * a Flight error row React keeps in production and hands to every reader of
 * the decoded error (Fizz on the document, the browser's boundaries on a
 * navigation). server/render-redirect-digest.ts writes it.
 *
 * This half reads it. Readers: `redirectSignalOf` (`decode-loader-results.ts`)
 * for the SSR shell error answer and the router's client boundaries,
 * `isSignalError` (`errors.ts`) for printing and reporting. Kept apart from
 * the writer so the browser bundle carries only the read.
 */

/** Starts every digest a component redirect writes. */
export const RENDER_REDIRECT_DIGEST_PREFIX = "rango.redirect;";

/** The redirect a render-thrown `redirect()` carries to its readers. */
export interface RenderRedirect {
  to: string;
  status: number;
  state?: Record<string, unknown>;
}

/** The component redirect digest an error carries, or undefined. */
export function renderRedirectDigestOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" &&
    digest.startsWith(RENDER_REDIRECT_DIGEST_PREFIX)
    ? digest
    : undefined;
}

/** The redirect a decoded Flight error carries, or undefined. */
export function renderRedirectOf(error: unknown): RenderRedirect | undefined {
  const digest = renderRedirectDigestOf(error);
  if (digest === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      digest.slice(RENDER_REDIRECT_DIGEST_PREFIX.length),
    ) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as RenderRedirect).to === "string"
    ) {
      return parsed as RenderRedirect;
    }
  } catch {
    // Not ours after all: an app digest that happens to share the prefix.
  }
  return undefined;
}
