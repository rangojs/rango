/**
 * Runtime-neutral Response shape utilities.
 *
 * Kept at the src/ root so both `router/` and `rsc/` can depend on it
 * without creating a cross-layer import cycle.
 */

/**
 * True when a Response represents a WebSocket upgrade handoff and must not
 * be reconstructed or mutated:
 *
 * - Status 101 (Switching Protocols) is outside the standard Response
 *   constructor's 200–599 range, so `new Response(body, { status: 101 })`
 *   throws RangeError on Node/undici and any spec-compliant runtime.
 * - Cloudflare's workerd attaches a non-standard `webSocket` property on
 *   the upgrade Response (e.g. from `acceptWebSocket`/`handleWebSocketUpgrade`
 *   or the `agents` library's `routeAgentRequest`). That property is dropped
 *   by a `new Response(...)` copy, breaking the upgrade even on workerd
 *   where the status range is relaxed.
 *
 * Callers should short-circuit header/body merges for these responses.
 */
export function isWebSocketUpgradeResponse(response: Response): boolean {
  return (
    response.status === 101 ||
    (response as unknown as { webSocket?: unknown }).webSocket != null
  );
}

// Location truthiness (not presence) so an empty `Location: ""` is not a redirect.
export function isRedirectResponse(response: Response): boolean {
  return (
    response.status >= 300 &&
    response.status < 400 &&
    Boolean(response.headers.get("Location"))
  );
}
