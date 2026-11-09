/**
 * A `redirect()` Response thrown while a COMPONENT renders, carried to its
 * read site through React's Flight error row.
 *
 * A Response thrown from a handler or a loader is caught by the router's own
 * code, so it stays a Response. A Response thrown from a component is caught
 * by React's Flight renderer, which reports the thrown value through
 * `onError` and emits an ERROR ROW for the nearest client boundary. The
 * digest that `onError` returns is the only data that reaches that read site:
 * the Flight client rebuilds a fresh Error from the row (masked in
 * production) and keeps `digest` alone. So a component-thrown redirect
 * travels as `error.digest`, and the two read sites that own the answer
 * resolve it back into a navigation:
 *
 * - a document load whose shell fails: `answerShellError`
 *   (`ssr/shell-error-document.tsx`) answers a real 3xx, as it does for a
 *   loader `redirect()` with no state;
 * - a client navigation, an action's revalidation, or a document whose shell
 *   streamed: `RootErrorBoundary` (`root-error-boundary.tsx`) mounts
 *   `LoaderRedirect`, the same carrier a loader `redirect()` uses.
 *
 * Control flow, never a failure: the render reports it to nothing, prints
 * nothing for it, and refuses to store the document (a redirect can depend on
 * the request). The digest carries the RESOLVED target
 * (`resolveSoftRedirect`), never the raw `Location`: the browser read site
 * hands it to `LoaderRedirect`, whose off-origin branch is the
 * `{ external: true }` channel, so a raw off-host target there would become an
 * unguarded `location.replace` while the document lane's outgoing guard
 * (`rsc/redirect-guard.ts`) neutralizes the same throw to the app root. One
 * resolution, here, keeps both read sites on the one rule.
 *
 * Kept at the `src/` root, runtime-neutral and import-light, because the RSC
 * render, the SSR shell answer and the browser boundary all need the one
 * format. The request origin and basename are passed in, not read from the
 * request context: this module runs in the browser too.
 */
import {
  getRedirectState,
  isExternalRedirect,
  resolveSoftRedirect,
} from "./redirect-origin.js";
import { isRedirectResponse } from "./response-utils.js";

/**
 * Digest prefix. Opaque to React (it only carries the string) and to anyone
 * reading a payload: only the two resolvers below interpret it.
 */
const PREFIX = "rango-redirect:";

/** What a component-thrown `redirect()` resolves to. */
export interface RenderRedirect {
  /**
   * The redirect's RESOLVED target (`resolveSoftRedirect`): the canonical
   * same-origin href, the http(s) off-host href the call opted into, or the
   * app's basename root when the same-origin rule blocks it. Never the raw
   * `Location` -- a client navigation cannot re-apply the rule (see
   * `renderRedirectDigest`).
   */
  location: string;
  /** The redirect's status (`302` unless the call passed one). */
  status: number;
  /**
   * The resolved location-state record, when the call passed
   * `redirect(url, { state })`. A client replace carries it into the target's
   * history entry; a 3xx cannot, so a redirect WITH state answers a recovery
   * document and navigates in the browser instead.
   */
  state?: Record<string, unknown>;
  /**
   * The call passed `redirect(url, { external: true })` AND the target is an
   * http(s) off-host one, so the opt-in still holds. The opt-in is an
   * out-of-band brand on the thrown Response (`redirect-origin.ts`), which a
   * 3xx rebuilt from this digest cannot carry, so such a target answers the
   * recovery document and leaves through the browser's external channel
   * (`LoaderRedirect` → `location.replace`) instead of being neutralized by
   * the outgoing same-origin guard. A branded target the scheme rule
   * neutralizes (a `javascript:` one) is not marked: it lands on the app root
   * like every other blocked target.
   */
  external?: true;
}

/**
 * The digest for a redirect Response thrown in a render, or `undefined` when
 * `value` is not one (the render's `onError` then reports it as an error).
 *
 * `requestOrigin` and `basename` are the request's, captured where the render
 * starts: a Flight `onError` can fire outside the request's ALS frame, so the
 * digest is built from values passed in, never from ambient state.
 */
export function renderRedirectDigest(
  value: unknown,
  requestOrigin: string,
  basename: string | undefined,
): string | undefined {
  if (!(value instanceof Response) || !isRedirectResponse(value)) {
    return undefined;
  }
  const external = isExternalRedirect(value);
  const resolved = resolveSoftRedirect(
    value.headers.get("Location")!,
    requestOrigin,
    basename,
    external,
  );
  const redirect: RenderRedirect = {
    location: resolved.to,
    status: value.status,
  };
  const state = getRedirectState(value);
  if (state) redirect.state = state;
  if (resolved.external) redirect.external = true;
  return PREFIX + JSON.stringify(redirect);
}

/**
 * The redirect an error carries, when its Flight error row was a
 * component-thrown `redirect()`. Name-free and instanceof-free on purpose:
 * the same row is decoded by the SSR Flight client and by the browser's,
 * whose module instances differ.
 */
export function renderRedirectOf(error: unknown): RenderRedirect | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith(PREFIX)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(digest.slice(PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { location, status, state, external } =
    parsed as Partial<RenderRedirect>;
  if (typeof location !== "string" || typeof status !== "number") {
    return undefined;
  }
  const redirect: RenderRedirect = { location, status };
  if (state && typeof state === "object") {
    redirect.state = state as Record<string, unknown>;
  }
  if (external === true) redirect.external = true;
  return redirect;
}
