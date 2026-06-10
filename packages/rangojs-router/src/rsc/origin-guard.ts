/**
 * Origin Guard
 *
 * Cross-origin request protection for server actions, loader fetches, and
 * progressive enhancement form submissions. Validates that the Origin header
 * (or Referer fallback) matches the request Host before executing.
 *
 * Requests without an Origin or Referer header are allowed — same-origin
 * navigations, bookmarks, and non-browser clients don't send Origin.
 */

import type { RequestPlan } from "../router/request-classification.js";

/**
 * Request phase that triggered the origin check.
 */
export type OriginCheckPhase = "action" | "loader" | "pe-form";

// Exhaustive over RequestPlan modes so a new mode must be classified here (the
// security gate) instead of silently falling through to no origin check.
export const ORIGIN_CHECK_PHASE_BY_MODE: Record<
  RequestPlan["mode"],
  OriginCheckPhase | null
> = {
  action: "action",
  loader: "loader",
  "pe-render": "pe-form",
  "full-render": null,
  "partial-render": null,
  response: null,
  redirect: null,
  "version-mismatch": null,
  // Terminal: handled before the origin guard (emits X-RSC-Reload, no execution).
  "app-switch": null,
};

/**
 * Context passed to the originCheck callback.
 */
export interface OriginCheckContext<TEnv = any> {
  request: Request;
  url: URL;
  env: TEnv;
  routerId: string;
  phase: OriginCheckPhase;
  /** Run the built-in conservative check (Origin/Referer vs Host + url.protocol). */
  defaultCheck: () => boolean;
}

/**
 * Configuration for the origin check.
 *
 * - `true` (default) — built-in conservative check
 * - `false` — disabled
 * - function — custom control; return true to allow, false to reject with
 *   default 403, or a Response for custom rejection
 */
export type OriginCheckConfig<TEnv = any> =
  | boolean
  | ((
      ctx: OriginCheckContext<TEnv>,
    ) => boolean | Response | Promise<boolean | Response>);

/**
 * Built-in conservative origin check.
 * Compares Origin (or Referer fallback) against Host + url.protocol.
 * Does NOT trust X-Forwarded-Host/Proto headers.
 *
 * Returns true to allow, false to reject.
 */
export function defaultOriginCheck(request: Request, url: URL): boolean {
  // 1. Read Origin header (present on all cross-origin requests and
  //    same-origin POST/PUT/PATCH/DELETE in modern browsers)
  let requestOrigin = request.headers.get("origin");

  // 2. Fallback to Referer if Origin is absent (some proxies strip it)
  if (!requestOrigin) {
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {
        // Malformed referer — treat as absent
      }
    }
  }

  // 3. No Origin or Referer — allow (can't be browser-initiated CSRF)
  if (!requestOrigin) return true;

  // "null" origin comes from privacy-sensitive contexts (data: URLs,
  // sandboxed iframes, cross-origin redirects). Reject it.
  if (requestOrigin === "null") return false;

  // 4. Determine expected host from Host header or URL.
  // X-Forwarded-Host/Proto are NOT used — they are client-controllable
  // unless a trusted proxy strips them. On standard deployments (Cloudflare
  // Workers, Node behind nginx/caddy) the Host header is already correct.
  // For non-standard setups, use the custom function escape hatch.
  const expectedHost = request.headers.get("host") || url.host;
  const expectedProtocol = url.protocol;

  // 5. Build expected origin and compare (case-insensitive)
  const expectedOrigin = `${expectedProtocol}//${expectedHost}`;

  return requestOrigin.toLowerCase() === expectedOrigin.toLowerCase();
}

function createForbiddenResponse(request: Request): Response {
  const isDev = process.env.NODE_ENV !== "production";
  const body = isDev
    ? "Forbidden: Origin mismatch. The request origin does not match the server host. " +
      `Set originCheck: false in createRouter() to disable this check. ` +
      `(Origin: ${request.headers.get("origin") ?? "none"}, ` +
      `Host: ${request.headers.get("host") ?? "none"})`
    : "Forbidden";

  return new Response(body, {
    status: 403,
    headers: { "X-Rango-Origin-Check": "failed" },
  });
}

/**
 * Configuration-aware origin check dispatcher.
 * Builds the OriginCheckContext and delegates to the configured check.
 */
export async function checkRequestOrigin<TEnv = any>(
  request: Request,
  url: URL,
  config: OriginCheckConfig<TEnv> | undefined,
  env: TEnv,
  routerId: string,
  phase: OriginCheckPhase,
): Promise<Response | null> {
  // Disabled by explicit opt-out
  if (config === false) return null;

  // Default (true/undefined) becomes a callback returning boolean, so the
  // Response|true|reject resolution below is written once.
  const check: (
    ctx: OriginCheckContext<TEnv>,
  ) => boolean | Response | Promise<boolean | Response> =
    config === true || config === undefined
      ? () => defaultOriginCheck(request, url)
      : config;

  const ctx: OriginCheckContext<TEnv> = {
    request,
    url,
    env,
    routerId,
    phase,
    defaultCheck: () => defaultOriginCheck(request, url),
  };

  const result = await check(ctx);

  if (result instanceof Response) return result;
  return result === true ? null : createForbiddenResponse(request);
}
