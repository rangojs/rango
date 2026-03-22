import { urls, createVar } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

const TestData = createVar<string>();

/**
 * Test routes for cache() scope guards.
 * Validates that response-level side effects (headers.set) throw inside
 * cache() boundaries, while ctx.set() remains allowed.
 */
export const cacheScopeGuardPatterns = urls(
  ({ path, layout, cache, errorBoundary }) => [
    layout(
      () => (
        <div data-testid="csg-layout">
          <nav>
            <Link to="/cache-scope-guard" data-testid="csg-link-index">
              Index
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/set-allowed"
              data-testid="csg-link-set"
            >
              ctx.set
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/header-blocked"
              data-testid="csg-link-header"
            >
              headers
            </Link>
          </nav>
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/",
          () => <div data-testid="csg-index">Cache Scope Guard Tests</div>,
          { name: "index" },
        ),

        // ctx.set() inside cache() — ALLOWED (children are also cached)
        cache({ ttl: 600 }, () => [
          path(
            "/set-allowed",
            (ctx) => {
              ctx.set(TestData, "from-cached-handler");
              return (
                <div data-testid="csg-set-page">
                  <span data-testid="csg-set-value">{ctx.get(TestData)}</span>
                </div>
              );
            },
            { name: "setAllowed" },
          ),
        ]),

        // ctx.headers.set() inside cache() — BLOCKED
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/header-blocked",
            (ctx) => {
              ctx.headers.set("X-Custom", "test");
              return <div data-testid="csg-header-page">Should not render</div>;
            },
            { name: "headerBlocked" },
          ),
        ]),
      ],
    ),
  ],
);
