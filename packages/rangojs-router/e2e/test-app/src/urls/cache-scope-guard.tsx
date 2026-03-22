import { urls, createVar } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

const CacheableData = createVar<string>();
const NonCacheableData = createVar<string>({ cache: false });

/**
 * Test routes for cache() scope guards.
 * - ctx.set() with cacheable var inside cache() — allowed
 * - ctx.set() with non-cacheable var (createVar({ cache: false })) — throws
 * - ctx.set() with write-level { cache: false } — throws
 * - ctx.get() of non-cacheable var inside cache() — throws
 * - ctx.headers.set() inside cache() — throws
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
              set (ok)
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/header-blocked"
              data-testid="csg-link-header"
            >
              headers
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/var-blocked"
              data-testid="csg-link-var"
            >
              var(cache:false)
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/write-blocked"
              data-testid="csg-link-write"
            >
              write(cache:false)
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

        // ctx.set() with cacheable var inside cache() — ALLOWED
        cache({ ttl: 600 }, () => [
          path(
            "/set-allowed",
            (ctx) => {
              ctx.set(CacheableData, "from-cached-handler");
              return (
                <div data-testid="csg-set-page">
                  <span data-testid="csg-set-value">
                    {ctx.get(CacheableData)}
                  </span>
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
              return <div>Should not render</div>;
            },
            { name: "headerBlocked" },
          ),
        ]),

        // ctx.set(NonCacheableVar, ...) inside cache() — BLOCKED (var-level policy)
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/var-blocked",
            (ctx) => {
              ctx.set(NonCacheableData, "user-specific");
              return <div>Should not render</div>;
            },
            { name: "varBlocked" },
          ),
        ]),

        // ctx.set(CacheableVar, ..., { cache: false }) inside cache() — BLOCKED (write-level)
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/write-blocked",
            (ctx) => {
              ctx.set(CacheableData, "sensitive", { cache: false });
              return <div>Should not render</div>;
            },
            { name: "writeBlocked" },
          ),
        ]),

        // ctx.set(NonCacheableVar) OUTSIDE cache, then ctx.get() INSIDE cache — BLOCKED
        path(
          "/read-blocked-setup",
          (ctx) => {
            // Set non-cacheable var outside cache scope (allowed)
            ctx.set(NonCacheableData, "user-data");
            return (
              <div data-testid="csg-read-setup">
                <Link
                  to="/cache-scope-guard/read-blocked"
                  data-testid="csg-link-read"
                >
                  Go to read test
                </Link>
              </div>
            );
          },
          { name: "readSetup" },
        ),
      ],
    ),
  ],
);
