/**
 * A `redirect()` Response thrown during the RSC render.
 *
 * A server component can only throw, and React's Flight renderer turns a throw
 * into an error row the browser renders through an error boundary. The one
 * thing that travels from that throw to the browser is the string the render's
 * `onError` returns, which React sends as the error row's `digest`
 * (`logRecoverableError` in react-server-dom-webpack). So a redirect thrown in
 * a component rides that channel: `rsc/render-pipeline.ts` returns the digest
 * built here, and the router's client boundaries mount the existing
 * `LoaderRedirect` for it instead of a fallback
 * (`route-content-wrapper.tsx`, `root-error-boundary.tsx`).
 *
 * The same digest answers a document whose shell the throw fails:
 * `renderHTML`'s shell error carries it, and `answerShellError`
 * (`ssr/shell-error-document.tsx`) answers the redirect's own 3xx, as it does
 * for a loader `redirect()` outside `<Suspense>`. A redirect with `state`
 * keeps the 200 recovery document there, because the state rides the history
 * entry the client replace writes, which a 3xx cannot carry.
 *
 * Shared by the server (`rsc/`, `ssr/`) and the browser (the two boundaries),
 * so it stays dependency free apart from the redirect rules every layer
 * already shares.
 */
import { getRedirectState, isExternalRedirect } from "./redirect-origin.js";
import { resolveSoftRedirectUrl } from "./redirect-origin.js";
import { isRedirectResponse } from "./response-utils.js";

/**
 * A redirect a render threw, in the form both halves of the router need: the
 * document answers `status` + `Location: to`, and the browser navigates to
 * `to` with `state`.
 */
export interface RenderedRedirect {
  to: string;
  status: number;
  state?: Record<string, unknown>;
}

/**
 * Digest prefix. A render error's digest is otherwise React's masked hash, so
 * this names both the origin of the value and its format; a digest an app or
 * React produced never starts with it.
 */
export const RENDERED_REDIRECT_DIGEST_PREFIX: string = "rango:redirect;";

/**
 * Resolve a thrown Response into a redirect a render can act on, or
 * `undefined` when it is not one (a 200 Response from a streamed handler is
 * not control flow).
 *
 * The target is resolved through the same soft-redirect rule every other
 * channel uses (`resolveSoftRedirectUrl`): an off-origin target without the
 * `redirect(url, { external: true })` brand is replaced with the app root
 * before it can leave the server, so the digest never carries a target the
 * client would refuse.
 */
export function renderedRedirectOf(
  value: unknown,
  request:
    | {
        origin: string;
        basename: string | undefined;
      }
    | undefined,
): RenderedRedirect | undefined {
  if (!(value instanceof Response) || !isRedirectResponse(value)) {
    return undefined;
  }
  const location = value.headers.get("Location")!;
  const to = request
    ? resolveSoftRedirectUrl(
        location,
        request.origin,
        request.basename,
        isExternalRedirect(value),
      )
    : location;
  const state = getRedirectState(value);
  return {
    to,
    status: value.status,
    ...(state && { state }),
  };
}

/**
 * The digest a Flight error row carries for a rendered redirect. JSON, because
 * `state` is a resolved location-state record (plain JSON by contract) and a
 * digest is a string field either way. A record that cannot be encoded keeps
 * the navigation and drops the state, with the same warning the document
 * state cookie gives in that case.
 */
export function renderedRedirectDigest(redirect: RenderedRedirect): string {
  try {
    return RENDERED_REDIRECT_DIGEST_PREFIX + JSON.stringify(redirect);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[rango] A redirect() thrown during the render carries state that is ` +
          `not JSON-encodable; the navigation keeps, the state is dropped.`,
        error,
      );
    }
    return (
      RENDERED_REDIRECT_DIGEST_PREFIX +
      JSON.stringify({ to: redirect.to, status: redirect.status })
    );
  }
}

/**
 * Read a rendered redirect back off an error: the Flight error row the browser
 * decoded (`digest` set by React's Flight client), or the shell error Fizz
 * rethrew from the same row. `undefined` for every other error.
 */
export function renderedRedirectFromError(
  error: unknown,
): RenderedRedirect | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const digest = (error as { digest?: unknown }).digest;
  if (
    typeof digest !== "string" ||
    !digest.startsWith(RENDERED_REDIRECT_DIGEST_PREFIX)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(digest.slice(RENDERED_REDIRECT_DIGEST_PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { to, status, state } = parsed as Record<string, unknown>;
  if (typeof to !== "string" || typeof status !== "number") return undefined;
  return {
    to,
    status,
    ...(state !== undefined &&
      typeof state === "object" &&
      state !== null && { state: state as Record<string, unknown> }),
  };
}
