import { urls, cookies, redirect } from "@rangojs/router";

/**
 * Content ownership / negotiation edge-case fixture.
 *
 * Proves which pipeline (response route vs RSC document) owns a given
 * request, and that ownership is stable across Accept headers, partial
 * requests, middleware redirects, errors, and auth guards.
 */
export const contentOwnershipPatterns = urls(({ path, middleware }) => [
  // Negotiated: RSC document + JSON on same path.
  // Accept header determines which pipeline runs.
  path(
    "/negotiated",
    () => <div data-testid="co-document-view">Document Owner</div>,
    { name: "negotiatedDoc" },
  ),
  path.json(
    "/negotiated",
    () => ({
      owner: "json",
      payload: "api-data",
    }),
    { name: "negotiatedJson" },
  ),

  // JSON response route that throws.
  // Error must stay as JSON with proper status, not fall to document shell.
  path.json(
    "/error-json",
    () => {
      throw new Error("intentional-response-error");
    },
    { name: "errorJson" },
  ),

  // Guarded JSON response route.
  // Rejection must return 403 JSON without leaking protected payload.
  path.json(
    "/guarded",
    () => ({
      secret: "classified-payload",
    }),
    { name: "guarded" },
    () => [
      middleware(async (ctx, next) => {
        if (!cookies().get("ownership-token")?.value) {
          return new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        await next();
      }),
    ],
  ),

  // Plain JSON response (no negotiation, no middleware).
  // Partial request here must produce X-RSC-Reload, not the JSON body.
  path.json(
    "/plain-json",
    () => ({
      data: "plain-response",
    }),
    { name: "plainJson" },
  ),

  // Response route with redirect middleware.
  // Redirect must fire; handler body must NOT be returned.
  path.json(
    "/redirect-guarded",
    () => ({
      data: "should-not-reach",
    }),
    { name: "redirectGuarded" },
    () => [
      middleware(async (_ctx, next) => {
        if (!cookies().get("ownership-token")?.value) {
          return redirect("/content-ownership/plain-json", 302);
        }
        await next();
      }),
    ],
  ),
]);
