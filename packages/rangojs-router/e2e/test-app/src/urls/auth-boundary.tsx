import { urls, cookies, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { authBoundaryFormAction } from "../actions.js";

// Shared auth check: cookie "auth-boundary-token" must be present.
function isAuthed(): boolean {
  return !!cookies().get("auth-boundary-token")?.value;
}

/**
 * Auth boundary test routes.
 *
 * Proves which middleware layer actually guards which execution phase:
 *   - Route middleware guards renders, NOT actions.
 *   - Global middleware guards everything (actions + renders).
 *   - Response routes follow the same middleware rules.
 */
export const authBoundaryPatterns = urls(({ path, middleware }) => [
  // Public landing page: shows auth status and navigation links.
  path(
    "/",
    (ctx) => {
      const authed = isAuthed();
      return (
        <div data-testid="auth-boundary-index">
          <h1 data-testid="auth-index-title">Auth Boundary Test</h1>
          <p data-testid="auth-status">
            {authed ? "authenticated" : "unauthenticated"}
          </p>
          <nav>
            <ul>
              <li>
                <Link
                  to="/auth-boundary/route-protected"
                  data-testid="route-protected-link"
                >
                  Route-MW Protected
                </Link>
              </li>
              <li>
                <Link
                  to="/auth-boundary/global-protected"
                  data-testid="global-protected-link"
                >
                  Global-MW Protected
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      );
    },
    { name: "index" },
  ),

  // Route-middleware-protected page + action.
  // The action is NOT guarded by route middleware (per execution model).
  path(
    "/route-protected",
    (ctx) => {
      return (
        <div data-testid="auth-boundary-route-protected">
          <h1 data-testid="route-protected-title">Route-MW Protected</h1>
          <p data-testid="route-protected-user">
            {cookies().get("auth-boundary-token")?.value ?? "none"}
          </p>
          <form
            action={authBoundaryFormAction}
            data-testid="route-protected-form"
          >
            <button type="submit" data-testid="route-protected-action-btn">
              Run Action
            </button>
          </form>
        </div>
      );
    },
    { name: "routeProtected" },
    () => [
      middleware(async (ctx, next) => {
        if (!isAuthed()) {
          cookies().set("auth-boundary-rejected-by", "route-mw", {
            path: "/",
            maxAge: 60,
          });
          return redirect("/auth-boundary?rejected=route-mw", 302);
        }
        ctx.header("X-Auth-Route-MW", "passed");
        await next();
      }),
    ],
  ),

  // Global-middleware-protected page + action.
  // Global MW guards BOTH the action AND the render.
  path(
    "/global-protected",
    (ctx) => {
      return (
        <div data-testid="auth-boundary-global-protected">
          <h1 data-testid="global-protected-title">Global-MW Protected</h1>
          <p data-testid="global-protected-user">
            {cookies().get("auth-boundary-token")?.value ?? "none"}
          </p>
          <form
            action={authBoundaryFormAction}
            data-testid="global-protected-form"
          >
            <button type="submit" data-testid="global-protected-action-btn">
              Run Action
            </button>
          </form>
        </div>
      );
    },
    { name: "globalProtected" },
  ),

  // Response route (JSON) behind route middleware.
  path.json(
    "/api/protected",
    () => {
      return { secret: "classified-data", ts: Date.now() };
    },
    { name: "apiProtected" },
    () => [
      middleware(async (ctx, next) => {
        if (!isAuthed()) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        await next();
      }),
    ],
  ),
]);
