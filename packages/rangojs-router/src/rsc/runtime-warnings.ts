/**
 * Runtime guardrail warnings (dev-only).
 *
 * W3: PE action redirect / Response handling.
 */

import {
  createResponseWithMergedHeaders,
  carryOverRedirectHeaders,
} from "./helpers.js";
import { isRedirectResponse } from "../response-utils.js";

// W3 -----------------------------------------------------------------------

/**
 * Extract a redirect Response from a thrown or returned value.
 * Returns a redirect Response to send to the client, or null if the value
 * is not a redirect Response.
 */
export function extractRedirectResponse(value: unknown): Response | null {
  if (!(value instanceof Response)) return null;
  if (!isRedirectResponse(value)) return null;
  const location = value.headers.get("Location")!;
  const redirect = createResponseWithMergedHeaders(null, {
    status: value.status,
    headers: { Location: location },
  });
  carryOverRedirectHeaders(value, redirect);
  return redirect;
}

/**
 * Warn when a non-redirect Response is returned from an action during PE.
 */
export function warnNonRedirectPeResponse(): void {
  console.warn(
    `[rango] Server action returned a non-redirect Response during ` +
      `progressive enhancement (no-JS) request. The Response will be ` +
      `ignored — the page will re-render at the current URL instead.`,
  );
}

/**
 * Warn when a non-redirect Response is returned (not thrown) from an action
 * on the JS (fetch) path. A raw Response cannot be serialized into Flight, so
 * it is discarded — mirroring the PE path. Use `throw redirect('/path')` for
 * redirects.
 */
export function warnNonRedirectActionResponse(actionId: string): void {
  console.warn(
    `[@rangojs/router] Server action "${actionId}" returned a Response ` +
      `that is not a redirect. Non-redirect Responses cannot be serialized ` +
      `and are ignored. Use \`throw redirect('/path')\` for redirects.`,
  );
}
