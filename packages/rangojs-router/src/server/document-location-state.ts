/**
 * Location state on document responses (#1330).
 *
 * A client navigation or an action carries server-set location state in its
 * Flight payload, and a redirect on either becomes a Flight redirect that
 * carries it too. A document request has no such channel for a 3xx: the
 * browser follows it with a plain GET. This module carries the state across
 * that one hop in a short-lived cookie:
 *
 * - `carryLocationStateAcrossRedirect` (rsc/request-stages.ts
 *   finalizeRequestResponse) writes it on a document request's same-origin
 *   3xx when the request set location state;
 * - `consumeDocumentLocationState` (rsc/request-stages.ts runRequestPasses)
 *   reads it on the next GET document request that navigates to the target
 *   pathname (`Sec-Fetch-Dest` a browsing context, where sent), seeds
 *   `_locationState` with its entries (so the render attaches them to the
 *   bootstrap payload, rsc/rsc-rendering.ts) and clears it.
 *
 * A document that carries location state is per visitor: it is marked
 * `_documentLocationState`, never stored by the document cache or as a PPR
 * shell, and leaves with `Cache-Control: private, no-store`
 * (`markDocumentResponsePrivate`).
 *
 * The value is JSON, not Flight: a cookie holds text, and the client merges
 * it as `history.state` would hold it. `Path=/` because the `__Host-` prefix
 * (https) requires it, which keeps a sibling subdomain from planting state;
 * the target pathname inside the value decides who consumes it.
 */

import {
  isLocationStateKey,
  resolveLocationStateEntries,
  type LocationStateEntry,
} from "../browser/react/location-state-shared.js";
import { getRawCookieValue } from "../browser/cookie-name.js";
import { isExternalRedirect } from "../redirect-origin.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
import { mayNeedSSR } from "../rsc/ssr-setup.js";
import { requestHeaders } from "./request-headers.js";
import {
  serializeCookieValue,
  type RequestContext,
} from "./request-context.js";

/** Seconds the cookie lives: one redirect hop, never a later visit. */
const DOCUMENT_LOCATION_STATE_MAX_AGE = 60;

/**
 * Upper bound of one serialized `Set-Cookie` (name, value and attributes).
 * Browsers keep at least 4096 bytes per cookie; the margin covers the
 * attributes some add.
 */
const DOCUMENT_LOCATION_STATE_MAX_BYTES = 4000;

const COOKIE_SUFFIX = "-ls";

const PRIVATE_NO_STORE = "private, no-store";

interface CarriedState {
  /** The pathname of the redirect target, the only request that reads it. */
  p: string;
  /** The resolved entries: slot key to value. */
  s: Record<string, unknown>;
}

/** The cookie's name for a router: `__Host-` on https. */
export function documentLocationStateCookieName(
  stateCookieName: string,
  secure: boolean,
): string {
  return `${secure ? "__Host-" : ""}${stateCookieName}${COOKIE_SUFFIX}`;
}

function cookieAttributes(secure: boolean): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
} {
  return { path: "/", httpOnly: true, secure, sameSite: "lax" };
}

/**
 * A document request: one that renders HTML (mayNeedSSR), not a navigation,
 * an action, a loader fetch or a Flight fetch. Those carry state in their
 * Flight payload, or are not what the browser shows.
 */
function isDocumentRequest(request: Request, url: URL): boolean {
  return mayNeedSSR(request, url);
}

function parseCarriedState(raw: string): CarriedState | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { p, s } = parsed as Partial<CarriedState>;
    if (typeof p !== "string" || s === null || typeof s !== "object") {
      return undefined;
    }
    return { p, s };
  } catch {
    return undefined;
  }
}

/**
 * `Sec-Fetch-Dest` values of a request that navigates a browsing context: the
 * one a browser makes when it follows a document redirect.
 */
const NAVIGATION_FETCH_DESTS: ReadonlySet<string> = new Set([
  "document",
  "iframe",
  "frame",
]);

/**
 * A request that navigates: the browser shows its response. Where the browser
 * sends `Sec-Fetch-Dest`, it must name a browsing context. A same-path
 * `fetch()` with a wildcard `Accept` or a `<link rel=prefetch>` passes
 * mayNeedSSR but sends `empty`, and must not eat the cookie before the
 * navigation it was left for. A request without the header (an older
 * browser, a non-browser client) keeps the mayNeedSSR rule alone.
 */
function isNavigationRequest(request: Request): boolean {
  const dest = requestHeaders(request).get("sec-fetch-dest");
  return dest === null || NAVIGATION_FETCH_DESTS.has(dest);
}

/**
 * Read the cookie a document redirect left for this request: seed
 * `_locationState` with its slots and clear it. Only a GET document request
 * of the target pathname that navigates consumes it (the request the browser
 * makes for a 301/302/303, see isNavigationRequest); any other request, a
 * form POST to that path or a prefetch of it included, leaves it to its
 * expiry. A malformed value is cleared and ignored, and only `__rsc_ls_*`
 * slots are taken from it (the value comes from the browser).
 */
export function consumeDocumentLocationState(
  reqCtx: Pick<RequestContext, "_locationState" | "setCookie">,
  request: Request,
  url: URL,
  stateCookieName: string,
): void {
  if (request.method !== "GET") return;
  if (!isDocumentRequest(request, url)) return;
  if (!isNavigationRequest(request)) return;
  const secure = url.protocol === "https:";
  const name = documentLocationStateCookieName(stateCookieName, secure);
  const raw = getRawCookieValue(requestHeaders(request).get("cookie"), name);
  if (raw === null) return;
  const carried = parseCarriedState(raw);
  if (carried && carried.p !== url.pathname) return;
  reqCtx.setCookie(name, "", { ...cookieAttributes(secure), maxAge: 0 });
  if (!carried) return;
  const entries: LocationStateEntry[] = [];
  for (const key of Object.keys(carried.s)) {
    if (!isLocationStateKey(key)) continue;
    entries.push({ __rsc_ls_key: key, __rsc_ls_value: carried.s[key] });
  }
  if (entries.length === 0) return;
  reqCtx._locationState = entries;
}

/** JSON keeps it as it is: what the cookie can carry without change. */
function isJsonPlain(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonPlain);
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every(
        (member) => member !== undefined && isJsonPlain(member),
      );
    }
    default:
      return false;
  }
}

function slotNames(state: Record<string, unknown>): string {
  return Object.keys(state).join(", ");
}

/**
 * Write the cookie on a document request's redirect that set location state,
 * and mark the redirect private. Not for a partial or action request (their
 * redirect is a Flight payload), an external or cross-origin target (the
 * cookie would never reach it) or a response that is not a 3xx with a
 * Location. Returns the response to send: a new one when its headers are
 * immutable.
 */
export function carryLocationStateAcrossRedirect(
  response: Response,
  reqCtx: Pick<RequestContext, "_locationState">,
  request: Request,
  url: URL,
  stateCookieName: string,
): Response {
  const entries = reqCtx._locationState;
  if (!entries || entries.length === 0) return response;
  if (!isDocumentRequest(request, url)) return response;
  if (response.status < 300 || response.status >= 400) return response;
  if (isExternalRedirect(response)) return response;
  const location = response.headers.get("Location");
  if (!location) return response;
  let target: URL;
  try {
    target = new URL(location, url);
  } catch {
    return response;
  }
  if (target.origin !== url.origin) return response;

  let state: Record<string, unknown>;
  try {
    state = resolveLocationStateEntries(entries);
  } catch (error) {
    // A lazy entry's getter threw: the redirect still leaves, without state.
    console.warn(
      "[rango] Location state was dropped from a document redirect: " +
        `resolving it threw (${String(error)}).`,
    );
    return response;
  }
  if (process.env.NODE_ENV !== "production") {
    for (const [key, value] of Object.entries(state)) {
      if (!isJsonPlain(value)) {
        console.warn(
          `[rango] Location state "${key}" crosses a document redirect as JSON, ` +
            "which does not keep this value as it is (a Date, Map, Set, bigint, " +
            "undefined or class instance). Store plain JSON data in state that a " +
            "document request redirects with.",
        );
      }
    }
  }

  const secure = url.protocol === "https:";
  const name = documentLocationStateCookieName(stateCookieName, secure);
  let cookie: string;
  try {
    cookie = serializeCookieValue(
      name,
      JSON.stringify({ p: target.pathname, s: state } satisfies CarriedState),
      { ...cookieAttributes(secure), maxAge: DOCUMENT_LOCATION_STATE_MAX_AGE },
    );
  } catch {
    console.warn(
      `[rango] Location state (${slotNames(state)}) was dropped from a document ` +
        "redirect: it cannot be serialized as JSON.",
    );
    return response;
  }
  if (cookie.length > DOCUMENT_LOCATION_STATE_MAX_BYTES) {
    console.warn(
      `[rango] Location state (${slotNames(state)}) was dropped from a document ` +
        `redirect: its cookie is ${cookie.length} bytes, over the ` +
        `${DOCUMENT_LOCATION_STATE_MAX_BYTES}-byte limit. Carry less state, or ` +
        "an id the target page loads the rest by.",
    );
    return response;
  }

  return withHeaders(response, (headers) => {
    headers.append("Set-Cookie", cookie);
    headers.set("Cache-Control", PRIVATE_NO_STORE);
  });
}

/**
 * Apply `write` to the response's headers, or to a copy of the response when
 * they are immutable (a `Response.redirect()`). A WebSocket upgrade is never
 * rebuilt and never carries location state.
 */
function withHeaders(
  response: Response,
  write: (headers: Headers) => void,
): Response {
  if (isWebSocketUpgradeResponse(response)) return response;
  try {
    write(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    write(copy.headers);
    return copy;
  }
}

/**
 * `Cache-Control: private, no-store` on a document that carries location
 * state, after every middleware: a shared cache must never store or replay
 * one visitor's state. Returns the response to send.
 */
export function markDocumentResponsePrivate(
  response: Response,
  reqCtx: Pick<RequestContext, "_documentLocationState">,
): Response {
  if (!reqCtx._documentLocationState) return response;
  return withHeaders(response, (headers) =>
    headers.set("Cache-Control", PRIVATE_NO_STORE),
  );
}
