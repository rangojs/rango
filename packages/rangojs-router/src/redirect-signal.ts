/**
 * A `redirect()` thrown by a SERVER COMPONENT, carried to the browser in the
 * one field React leaves the server in a Flight error row: the digest.
 *
 * `redirect()` is a thrown `Response`, and a handler's throw still reaches a
 * place that answers it (segment-resolution rethrows it, rsc/handler.ts turns
 * it into a 3xx or a soft redirect). A component's throw happens inside the
 * Flight render, where the only thing a caller can do is what React's
 * `onError` returns: that string becomes the row's `digest`
 * (`<id>:E{"digest":"..."}`), and the browser reads it back as
 * `error.digest`. By then a navigation's headers and the payload's first rows
 * have left the server, so no HTTP status can answer it; the digest is the
 * only in-band channel left, and it is the same design Next.js uses for its
 * `NEXT_REDIRECT` digests.
 *
 * Two consumers read it, both router-owned:
 * - `ssr/shell-error-document.tsx` answers a document request with a real 3xx
 *   (nothing has been flushed when the shell fails).
 * - `root-error-boundary.tsx` (and the public `ErrorBoundary`) renders
 *   `LoaderRedirect` for a client navigation, the loader lane's
 *   replace-navigation.
 *
 * The target is resolved through {@link resolveSoftRedirectUrl} before it is
 * encoded, so a cross-origin target without the `{ external: true }` brand
 * lands on the app root exactly as it does on every other redirect channel;
 * the client re-validates what it decodes (LoaderRedirect).
 */

import {
  getRedirectState,
  isExternalRedirect,
  resolveSoftRedirectUrl,
} from "./redirect-origin.js";

/** Prefix of every redirect digest; nothing else may produce one. */
export const REDIRECT_DIGEST_PREFIX: string = "rango-redirect:";

/** A `redirect()` thrown during a render, as the browser needs it. */
export interface RedirectSignal {
  /** Resolved target: same-origin href, or the http(s) href of `external`. */
  to: string;
  /** `redirect()`'s status, for the document answer's 3xx. */
  status?: number;
  /** The `{ external: true }` opt-in. */
  external?: boolean;
  /** The resolved `redirect(url, { state })` record, merged at the target. */
  state?: Record<string, unknown>;
}

/**
 * Encode a signal as the digest `onError` returns. `encodeURIComponent` keeps
 * the digest plain ASCII inside the row's JSON string, whatever the URL holds.
 */
export function encodeRedirectDigest(signal: RedirectSignal): string {
  return REDIRECT_DIGEST_PREFIX + encodeURIComponent(JSON.stringify(signal));
}

/** Decode a digest into its signal, or undefined for any other digest. */
export function decodeRedirectDigest(
  digest: unknown,
): RedirectSignal | undefined {
  if (typeof digest !== "string") return undefined;
  if (!digest.startsWith(REDIRECT_DIGEST_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(digest.slice(REDIRECT_DIGEST_PREFIX.length)),
    ) as Partial<RedirectSignal>;
    if (typeof parsed?.to !== "string") return undefined;
    return parsed as RedirectSignal;
  } catch {
    return undefined;
  }
}

/**
 * The signal an error carries, if any: a Flight error row's decoded digest, or
 * a local error that was handed one.
 */
export function redirectSignalOfError(
  error: unknown,
): RedirectSignal | undefined {
  if (error === null || typeof error !== "object") return undefined;
  return decodeRedirectDigest((error as { digest?: unknown }).digest);
}

/**
 * The signal a thrown `redirect()` Response carries, with its target resolved
 * under the same-origin rule every other redirect channel uses. Undefined when
 * the Response is not a redirect (no `Location`).
 */
export function redirectSignalOfResponse(
  response: Response,
  opts: { requestOrigin: string; basename?: string },
): RedirectSignal | undefined {
  const location = response.headers.get("Location");
  if (!location) return undefined;
  const external = isExternalRedirect(response);
  const signal: RedirectSignal = {
    to: resolveSoftRedirectUrl(
      location,
      opts.requestOrigin,
      opts.basename,
      external,
    ),
    status: response.status,
  };
  if (external) signal.external = true;
  const state = getRedirectState(response);
  if (state) signal.state = state;
  return signal;
}
