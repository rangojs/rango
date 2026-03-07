/**
 * Runtime guardrail warnings (dev-only).
 *
 * W1: Route middleware is not an action guard.
 * W3: PE action redirect / Response handling.
 */

import { createResponseWithMergedHeaders } from "./helpers.js";

// W1 -----------------------------------------------------------------------

const warnedActionRoutes = new Set<string | undefined>();

/**
 * Warn (once per route key) that route middleware does not guard actions.
 * Call site: handler.ts, inside the `isAction && actionId` branch.
 */
export function warnActionWithRouteMiddleware(
  actionId: string,
  routeKey: string | undefined,
): void {
  if (warnedActionRoutes.has(routeKey)) return;
  warnedActionRoutes.add(routeKey);
  console.warn(
    `[rango] Route middleware does not guard server actions. The action "${actionId}" ` +
      `executed before route middleware ran. Route middleware only wraps the ` +
      `render/revalidation pass. To guard actions, use global middleware or ` +
      `validate inside the action itself.`,
  );
}

/** Reset deduplication state (for tests only). */
export function _resetW1Warnings(): void {
  warnedActionRoutes.clear();
}

// W3 -----------------------------------------------------------------------

/**
 * Extract a redirect Response from a thrown or returned value.
 * Returns a redirect Response to send to the client, or null if the value
 * is not a redirect Response.
 */
export function extractRedirectResponse(value: unknown): Response | null {
  if (!(value instanceof Response)) return null;
  const location = value.headers.get("Location");
  if (value.status >= 300 && value.status < 400 && location) {
    return createResponseWithMergedHeaders(null, {
      status: value.status,
      headers: { Location: location },
    });
  }
  return null;
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
