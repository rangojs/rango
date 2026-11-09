/**
 * A `redirect()` thrown while React serializes the payload: an async server
 * component (or anything else Flight renders) that throws the Response after
 * the handler returned. No router catch sees it: the handler already
 * returned, so the throw surfaces in Flight's onError, after the status line
 * may have gone out. It travels as the error row's `digest`, the one field of
 * a Flight error row React keeps in production and hands to every reader of
 * the decoded error (Fizz on the document, the browser's boundaries on a
 * navigation).
 *
 * The digest carries the target already resolved through the soft-redirect
 * rules (`resolveSoftRedirectUrl`, same-origin unless `{ external: true }`),
 * so the wire never holds an unresolved target, exactly as the loader
 * redirect marker (`loader-resolution.ts`). Readers: `redirectSignalOf`
 * (`decode-loader-results.ts`) for the SSR shell error answer and the
 * router's client boundaries, `isSignalError` (`errors.ts`) for printing and
 * reporting.
 *
 * Runtime-neutral leaf: the RSC, SSR and browser environments each import it.
 */
import {
  getRedirectState,
  isExternalRedirect,
  resolveSoftRedirectUrl,
} from "./redirect-origin.js";
import { isRedirectResponse } from "./response-utils.js";

const DIGEST_PREFIX = "rango.redirect;";

/** The redirect a render-thrown `redirect()` carries to its readers. */
export interface RenderRedirect {
  to: string;
  status: number;
  state?: Record<string, unknown>;
}

/** Where the request came from, read before Flight's onError runs. */
export interface RenderRedirectOrigin {
  origin: string | undefined;
  basename: string | undefined;
}

/**
 * The origin a request context resolves redirects against: its original URL
 * (before a rewrite), as the loader marker resolves them. Read where the
 * render starts: Flight calls onError outside the request's async context.
 */
export function renderRedirectOrigin(
  ctx: { originalUrl?: URL; url?: URL; _basename?: string } | undefined,
): RenderRedirectOrigin {
  return {
    origin: (ctx?.originalUrl ?? ctx?.url)?.origin,
    basename: ctx?._basename,
  };
}

/**
 * Flight's onError for an encode that is decoded and rendered again (a
 * "use cache" result, a stored segment): `onError` still sees every error, a
 * redirect included, so its writer refuses the entry, and the error row keeps
 * the redirect's digest, so the render that decodes it hands the redirect on.
 */
export function redirectAwareOnError(
  origin: RenderRedirectOrigin,
  onError?: (error: unknown) => void,
): (error: unknown) => string | undefined {
  return (error) => {
    onError?.(error);
    return renderRedirectDigest(error, origin);
  };
}

function digestOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith(DIGEST_PREFIX)
    ? digest
    : undefined;
}

function encode(redirect: RenderRedirect): string {
  try {
    return DIGEST_PREFIX + JSON.stringify(redirect);
  } catch {
    // State that JSON cannot hold (a BigInt, a cycle): the redirect still
    // navigates, without it, as a document redirect's state cookie would
    // refuse it too.
    const { state: _state, ...rest } = redirect;
    return DIGEST_PREFIX + JSON.stringify(rest);
  }
}

/**
 * The digest Flight's onError returns for `error`: a redirect Response,
 * resolved for this request, or an error that already carries one (decoded
 * from an inner Flight render, such as a stored segment, and thrown again).
 * Undefined for anything else, which keeps React's own digest.
 */
export function renderRedirectDigest(
  error: unknown,
  request: RenderRedirectOrigin,
): string | undefined {
  if (error instanceof Response) {
    if (!isRedirectResponse(error)) return undefined;
    const location = error.headers.get("Location")!;
    const to = request.origin
      ? resolveSoftRedirectUrl(
          location,
          request.origin,
          request.basename,
          isExternalRedirect(error),
        )
      : location;
    const state = getRedirectState(error);
    return encode({ to, status: error.status, ...(state && { state }) });
  }
  return digestOf(error);
}

/** The redirect a decoded Flight error carries, or undefined. */
export function renderRedirectOf(error: unknown): RenderRedirect | undefined {
  const digest = digestOf(error);
  if (digest === undefined) return undefined;
  try {
    const parsed = JSON.parse(digest.slice(DIGEST_PREFIX.length)) as unknown;
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
