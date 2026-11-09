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
 * the request). `Location` is already resolved and basename-prefixed by
 * `redirect()` itself, and the outgoing 3xx still passes the same-origin
 * guard (`rsc/redirect-guard.ts`) like every other browser-followed redirect.
 *
 * Kept at the `src/` root, runtime-neutral and import-light, because the RSC
 * render, the SSR shell answer and the browser boundary all need the one
 * format.
 */
import { getRedirectState, isExternalRedirect } from "./redirect-origin.js";
import { isRedirectResponse } from "./response-utils.js";

/**
 * Digest prefix. Opaque to React (it only carries the string) and to anyone
 * reading a payload: only the two resolvers below interpret it.
 */
const PREFIX = "rango-redirect:";

/** What a component-thrown `redirect()` resolves to. */
export interface RenderRedirect {
  /** The redirect's `Location`, basename-prefixed and unresolved (soft). */
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
   * The call passed `redirect(url, { external: true })`. The opt-in is an
   * out-of-band brand on the thrown Response (`redirect-origin.ts`), which a
   * 3xx rebuilt from this digest cannot carry, so an off-host target answers
   * the recovery document and leaves through the browser's external channel
   * (`LoaderRedirect` → `location.replace`) instead of being neutralized by
   * the outgoing same-origin guard.
   */
  external?: true;
}

/**
 * The digest for a redirect Response thrown in a render, or `undefined` when
 * `value` is not one (the render's `onError` then reports it as an error).
 */
export function renderRedirectDigest(value: unknown): string | undefined {
  if (!(value instanceof Response) || !isRedirectResponse(value)) {
    return undefined;
  }
  const redirect: RenderRedirect = {
    location: value.headers.get("Location")!,
    status: value.status,
  };
  const state = getRedirectState(value);
  if (state) redirect.state = state;
  if (isExternalRedirect(value)) redirect.external = true;
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
