import { createVar, getRequestContext, urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { ActionRouteMwProbe } from "../components/ActionRouteMwProbe.js";
import { actionRouteMwThrow } from "../actions.js";

/**
 * Action error-boundary + route-middleware fixture (C3).
 *
 * Route middleware sets X-Action-Route-Mw on the response (after next()). Inside
 * the same scope sits an error boundary and the probe page. The e2e fires a
 * succeeding action AND a throwing action (which renders the error boundary) and
 * asserts the route-middleware header is present on BOTH action responses.
 *
 * Before the C3 fix the error-boundary render was built and returned by
 * executeServerAction directly, bypassing route middleware — so the header was
 * present on the success response but ABSENT on the error-boundary response.
 *
 * The middleware also sets a var the boundary reads, and a no-JS form posts the
 * throwing action: the boundary renders inside route middleware in JS and
 * no-JS alike (semantic matrix A3).
 */
const ActionRouteMwVar = createVar<string>();

function ActionRouteMwBoundary() {
  return (
    <div data-testid="action-route-mw-error-boundary">
      Action error boundary
      <span data-testid="action-route-mw-boundary-var">
        {getRequestContext().get(ActionRouteMwVar) ?? "none"}
      </span>
    </div>
  );
}

export const actionRouteMwPatterns = urls(
  ({ path, layout, middleware, errorBoundary }) => [
    middleware(
      async (ctx, next) => {
        ctx.set(ActionRouteMwVar, "from-route-mw");
        await next();
        ctx.header("X-Action-Route-Mw", "applied");
      },
      () => [
        layout(
          () => <Outlet />,
          () => [
            errorBoundary(() => <ActionRouteMwBoundary />),
            path(
              "/",
              () => (
                <div data-testid="action-route-mw-page">
                  <ActionRouteMwProbe />
                  <form action={actionRouteMwThrow}>
                    <button
                      type="submit"
                      data-testid="action-route-mw-pe-throw"
                    >
                      Throw Action (no JS)
                    </button>
                  </form>
                </div>
              ),
              { name: "index" },
            ),
          ],
        ),
      ],
    ),
  ],
);
