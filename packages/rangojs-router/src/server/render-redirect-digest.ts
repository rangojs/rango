/**
 * Writes the digest of a `redirect()` a component threw while Flight
 * serialized the payload (render-redirect.ts explains the channel and holds
 * the read). The target is resolved here through the soft-redirect rules
 * (`resolveSoftRedirectUrl`, same-origin unless `{ external: true }`), so the
 * wire never holds an unresolved target, exactly as the loader redirect
 * marker (`loader-resolution.ts`).
 *
 * Writers: `createFlightStage` (`rsc/render-pipeline.ts`) for every response
 * and every encode in `cache/segment-codec.ts` (redirectAwareOnError).
 */
import {
  getRedirectState,
  isExternalRedirect,
  resolveSoftRedirectUrl,
} from "../redirect-origin.js";
import { isRedirectResponse } from "../response-utils.js";
import {
  RENDER_REDIRECT_DIGEST_PREFIX,
  renderRedirectDigestOf,
  type RenderRedirect,
} from "../render-redirect.js";

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
 * Responses a handler streamed behind loading() rejected or resolved with.
 * They stay on the error path, as execution-model.md's "Limitation: a
 * Response from an async handler under loading() is not a redirect" states:
 * no digest is written for them. Marked by trackStreamedHandler, upstream of
 * every chain Flight reads, so the mark lands before Flight sees the value.
 */
const streamedHandlerResponses = new WeakSet<Response>();

/** Keep `value`, if it is a Response, out of the redirect digest. */
export function markStreamedHandlerResponse(value: unknown): void {
  if (value instanceof Response) streamedHandlerResponses.add(value);
}

function encode(redirect: RenderRedirect): string {
  try {
    return RENDER_REDIRECT_DIGEST_PREFIX + JSON.stringify(redirect);
  } catch {
    // State that JSON cannot hold (a BigInt, a cycle): the redirect still
    // navigates, without it, as a document redirect's state cookie would
    // refuse it too.
    const { state: _state, ...rest } = redirect;
    return RENDER_REDIRECT_DIGEST_PREFIX + JSON.stringify(rest);
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
    if (!isRedirectResponse(error) || streamedHandlerResponses.has(error)) {
      return undefined;
    }
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
  return renderRedirectDigestOf(error);
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
