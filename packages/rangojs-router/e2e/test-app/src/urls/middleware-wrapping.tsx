import { urls, createVar } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

const SingleMwVar = createVar<string>();
const ArrayMwVar = createVar<string>();

/**
 * Middleware wrapping test patterns.
 *
 * Tests that middleware(fn, () => [...]) and middleware([fn1, fn2], () => [...])
 * scope middleware to their children only. A sibling route outside the wrapper
 * must NOT see the middleware-set variables.
 */
export const middlewareWrappingPatterns = urls(
  ({ path, layout, middleware }) => [
    layout(
      () => <Outlet />,
      () => [
        // Single-fn wrapping middleware
        middleware(
          async (ctx, next) => {
            ctx.set(SingleMwVar, "from-single-wrap");
            await next();
            ctx.header("X-Single-Wrap", "applied");
          },
          () => [
            path(
              "/single",
              (ctx) => {
                const value = ctx.get(SingleMwVar);
                return (
                  <div data-testid="mw-wrap-single-page">
                    <span data-testid="mw-wrap-single-value">
                      {value ?? "none"}
                    </span>
                    <Link
                      to="/middleware-wrapping/outside"
                      data-testid="link-to-outside"
                    >
                      Go outside
                    </Link>
                  </div>
                );
              },
              { name: "single" },
            ),
          ],
        ),

        // Array-fn wrapping middleware (two middleware functions)
        middleware(
          [
            async (ctx, next) => {
              ctx.set(ArrayMwVar, "from-array-wrap");
              await next();
            },
            async (ctx, next) => {
              await next();
              ctx.header("X-Array-Wrap", "applied");
            },
          ],
          () => [
            path(
              "/array",
              (ctx) => {
                const value = ctx.get(ArrayMwVar);
                return (
                  <div data-testid="mw-wrap-array-page">
                    <span data-testid="mw-wrap-array-value">
                      {value ?? "none"}
                    </span>
                  </div>
                );
              },
              { name: "array" },
            ),
          ],
        ),

        // Route OUTSIDE both wrappers — should NOT see either variable
        path(
          "/outside",
          (ctx) => {
            const singleValue = ctx.get(SingleMwVar);
            const arrayValue = ctx.get(ArrayMwVar);
            return (
              <div data-testid="mw-wrap-outside-page">
                <span data-testid="mw-wrap-outside-single">
                  {singleValue ?? "none"}
                </span>
                <span data-testid="mw-wrap-outside-array">
                  {arrayValue ?? "none"}
                </span>
              </div>
            );
          },
          { name: "outside" },
        ),
      ],
    ),
  ],
);
