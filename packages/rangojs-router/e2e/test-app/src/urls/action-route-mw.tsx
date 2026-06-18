import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { ActionRouteMwProbe } from "../components/ActionRouteMwProbe.js";

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
 */
export const actionRouteMwPatterns = urls(
  ({ path, layout, middleware, errorBoundary }) => [
    middleware(
      async (ctx, next) => {
        await next();
        ctx.header("X-Action-Route-Mw", "applied");
      },
      () => [
        layout(
          () => <Outlet />,
          () => [
            errorBoundary(() => (
              <div data-testid="action-route-mw-error-boundary">
                Action error boundary
              </div>
            )),
            path(
              "/",
              () => (
                <div data-testid="action-route-mw-page">
                  <ActionRouteMwProbe />
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
