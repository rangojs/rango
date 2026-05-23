import { urls, createVar, Meta, getRequestContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  NonCacheableData,
  NonCacheableReaderLoader,
  AsyncNonCacheableReaderLoader,
  CookieWriterLoader,
} from "./cache-scope-guard-loader.js";

const CacheableData = createVar<string>();

/**
 * Test routes for cache() scope guards.
 * - ctx.set() with cacheable var inside cache() — allowed
 * - ctx.set() with non-cacheable var (createVar({ cache: false })) — set OK; ctx.get() throws
 * - ctx.set() with write-level { cache: false } — set OK; ctx.get() throws
 * - ctx.get() of non-cacheable var inside cache() — throws
 * - ctx.headers.set() inside cache() — throws
 */
export const cacheScopeGuardPatterns = urls(
  ({ path, layout, cache, errorBoundary, parallel, loader }) => [
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
            {" | "}
            <Link
              to="/cache-scope-guard/read-blocked"
              data-testid="csg-link-read"
            >
              read(cache:false)
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/parallel-read-blocked"
              data-testid="csg-link-parallel"
            >
              @meta read
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/reqctx-read-blocked"
              data-testid="csg-link-reqctx-read"
            >
              reqCtx.get
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/reqctx-header-blocked"
              data-testid="csg-link-reqctx-header"
            >
              reqCtx.header
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/loader-read-allowed"
              data-testid="csg-link-loader"
            >
              loader read
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/async-loader-read-allowed"
              data-testid="csg-link-async-loader"
            >
              async loader
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

        // createVar({ cache: false }) — set then get inside cache() — BLOCKED at read time
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/var-blocked",
            (ctx) => {
              ctx.set(NonCacheableData, "user-specific"); // write OK (dumb)
              const val = ctx.get(NonCacheableData); // read guard fires
              return <div>Should not render: {val}</div>;
            },
            { name: "varBlocked" },
          ),
        ]),

        // ctx.set(var, val, { cache: false }) then ctx.get() inside cache() — BLOCKED
        // Write is dumb (stores metadata), read triggers the guard.
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
              const val = ctx.get(CacheableData); // read guard fires here
              return <div>Should not render: {val}</div>;
            },
            { name: "writeBlocked" },
          ),
        ]),

        // @meta parallel inside cache() reading non-cacheable var — BLOCKED
        layout(
          (ctx) => {
            ctx.set(NonCacheableData, "user-session");
            return <Outlet />;
          },
          () => [
            cache({ ttl: 600 }, () => [
              errorBoundary((props) => (
                <div data-testid="csg-error-page">
                  <span data-testid="csg-error-message">
                    {props.error.message}
                  </span>
                </div>
              )),
              path(
                "/parallel-read-blocked",
                () => <div data-testid="csg-parallel-page">Product</div>,
                { name: "parallelReadBlocked" },
                () => [
                  parallel({
                    "@meta": (ctx) => {
                      // Parallel reads non-cacheable var inside cache() — should throw
                      const session = ctx.get(NonCacheableData);
                      ctx.use(Meta)({ title: `User: ${session}` });
                      return null;
                    },
                  }),
                ],
              ),
            ]),
          ],
        ),

        // getRequestContext().get(NonCacheableVar) inside cache() — BLOCKED
        layout(
          (ctx) => {
            ctx.set(NonCacheableData, "user-session");
            return <Outlet />;
          },
          () => [
            cache({ ttl: 600 }, () => [
              errorBoundary((props) => (
                <div data-testid="csg-error-page">
                  <span data-testid="csg-error-message">
                    {props.error.message}
                  </span>
                </div>
              )),
              path(
                "/reqctx-read-blocked",
                () => {
                  const reqCtx = getRequestContext();
                  const val = reqCtx.get(NonCacheableData);
                  return <div>Should not render: {val}</div>;
                },
                { name: "reqCtxReadBlocked" },
              ),
            ]),
          ],
        ),

        // getRequestContext().header() inside cache() — BLOCKED
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/reqctx-header-blocked",
            () => {
              const reqCtx = getRequestContext();
              reqCtx.header("X-Custom", "test");
              return <div>Should not render</div>;
            },
            { name: "reqCtxHeaderBlocked" },
          ),
        ]),

        // Loader reading non-cacheable var inside cache() — ALLOWED
        // Loaders are always fresh (never cached), so they're exempt.
        layout(
          (ctx) => {
            ctx.set(NonCacheableData, "loader-session");
            return <Outlet />;
          },
          () => [
            cache({ ttl: 600 }, () => [
              path(
                "/loader-read-allowed",
                async (ctx) => {
                  const { session } = await ctx.use(NonCacheableReaderLoader);
                  return (
                    <div data-testid="csg-loader-page">
                      <span data-testid="csg-loader-value">{session}</span>
                    </div>
                  );
                },
                { name: "loaderReadAllowed" },
                () => [loader(NonCacheableReaderLoader)],
              ),
              // Async loader — reads non-cacheable var AFTER await
              path(
                "/async-loader-read-allowed",
                async (ctx) => {
                  const { session } = await ctx.use(
                    AsyncNonCacheableReaderLoader,
                  );
                  return (
                    <div data-testid="csg-async-loader-page">
                      <span data-testid="csg-async-loader-value">
                        {session}
                      </span>
                    </div>
                  );
                },
                { name: "asyncLoaderReadAllowed" },
                () => [loader(AsyncNonCacheableReaderLoader)],
              ),
            ]),
          ],
        ),

        // Loader calling cookies().set() inside cache() — ALLOWED
        // Response-level side effects are safe in DSL loaders (always fresh).
        // The handler reads the result via ctx.use() which returns the
        // memoized promise from the DSL-started loader (standard pattern).
        cache({ ttl: 600 }, () => [
          path(
            "/loader-cookie-allowed",
            async (ctx) => {
              const { wrote } = await ctx.use(CookieWriterLoader);
              return (
                <div data-testid="csg-loader-cookie-page">
                  <span data-testid="csg-loader-cookie-value">
                    {wrote ? "cookie-written" : "no-write"}
                  </span>
                </div>
              );
            },
            { name: "loaderCookieAllowed" },
            () => [loader(CookieWriterLoader)],
          ),
        ]),

        // ctx.get(NonCacheableVar) inside cache() — BLOCKED (read guard)
        // Layout OUTSIDE cache sets the var, route INSIDE cache reads it
        layout(
          (ctx) => {
            // Set non-cacheable var outside cache scope — allowed
            ctx.set(NonCacheableData, "user-session-data");
            return <Outlet />;
          },
          () => [
            cache({ ttl: 600 }, () => [
              errorBoundary((props) => (
                <div data-testid="csg-error-page">
                  <span data-testid="csg-error-message">
                    {props.error.message}
                  </span>
                </div>
              )),
              path(
                "/read-blocked",
                (ctx) => {
                  // Reading non-cacheable var inside cache scope — should throw
                  const data = ctx.get(NonCacheableData);
                  return (
                    <div data-testid="csg-read-page">
                      Should not render: {data}
                    </div>
                  );
                },
                { name: "readBlocked" },
              ),
            ]),
          ],
        ),
      ],
    ),
  ],
);
