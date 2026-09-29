import {
  urls,
  createVar,
  Meta,
  getRequestContext,
  cookies,
  headers,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  NonCacheableData,
  NonCacheableReaderLoader,
  AsyncNonCacheableReaderLoader,
  CookieWriterLoader,
  CookieReaderLoader,
  HandlerInvokedCookieWriterLoader,
  CachedSessionLoader,
} from "./cache-scope-guard-loader.js";
import { CacheScopeGuardCookieReader } from "../components/CacheScopeGuardCookieReader.js";

const CacheableData = createVar<string>();

// Issue #925: the key has no argument, so a stored result would carry the
// first caller's NonCacheableData to every later caller; the read throws.
async function getTenantLabelFromVar(): Promise<string> {
  "use cache";
  return `label-${getRequestContext().get(NonCacheableData)}`;
}

// The value is an argument, so it keys the entry.
async function getTenantLabel(
  tenant: string,
): Promise<{ tenant: string; stamp: string }> {
  "use cache";
  return { tenant, stamp: `${Date.now()}-${Math.random()}` };
}

/**
 * Test routes for cache() scope guards.
 * - ctx.set() with cacheable var inside cache() — allowed
 * - ctx.set() with non-cacheable var (createVar({ cache: false })) — set OK; ctx.get() throws
 * - ctx.set() with write-level { cache: false } — set OK; ctx.get() throws
 * - ctx.get() of non-cacheable var inside cache() — throws
 * - ctx.headers.set() inside cache() — throws
 * - getRequestContext().get() of non-cacheable var inside "use cache" — throws
 *   (/use-cache-read-blocked)
 * - non-cacheable value passed into "use cache" as an argument — allowed,
 *   keyed per value (/use-cache-arg-keyed)
 * - cookies() in the body of a loader with its own cache() and no key() —
 *   the fill fails (/loader-cache-unkeyed, #972), also when a parent layout
 *   handler ran the loader first (/loader-cache-reader-first); with a key()
 *   that includes the cookie — allowed, keyed per session (/loader-cache-keyed)
 */
export const cacheScopeGuardPatterns = urls(
  ({ path, layout, cache, errorBoundary, parallel, loader, middleware }) => [
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
            {" | "}
            <Link
              to="/cache-scope-guard/cookies-read-blocked"
              data-testid="csg-link-cookies-read"
            >
              cookies() read
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/headers-read-blocked"
              data-testid="csg-link-headers-read"
            >
              headers() read
            </Link>
            {" | "}
            <Link
              to="/cache-scope-guard/loader-cookies-allowed"
              data-testid="csg-link-loader-cookies"
            >
              loader cookies()
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

        // Handler-invoked loader (NOT registered via loader()) calling
        // cookies().set() inside cache() — BLOCKED (#725). Unlike
        // /loader-cookie-allowed above, the loader is consumed only via ctx.use
        // and is never re-run on a HIT (the handler is skipped), so its
        // Set-Cookie would land only on the MISS and vanish on hits. The guard
        // throws deterministically on the first render instead.
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/handler-loader-cookie-blocked",
            async (ctx) => {
              await ctx.use(HandlerInvokedCookieWriterLoader);
              return <div>Should not render</div>;
            },
            { name: "handlerLoaderCookieBlocked" },
          ),
        ]),

        // cookies() read inside cache() — BLOCKED (read-purity guard)
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/cookies-read-blocked",
            () => {
              const session = cookies().get("csg-session")?.value;
              return <div>Should not render: {session}</div>;
            },
            { name: "cookiesReadBlocked" },
          ),
        ]),

        // headers() read inside cache() — BLOCKED (read-purity guard)
        cache({ ttl: 600 }, () => [
          errorBoundary((props) => (
            <div data-testid="csg-error-page">
              <span data-testid="csg-error-message">{props.error.message}</span>
            </div>
          )),
          path(
            "/headers-read-blocked",
            () => {
              const auth = headers().get("authorization");
              return <div>Should not render: {auth}</div>;
            },
            { name: "headersReadBlocked" },
          ),
        ]),

        // cookies() read by a DSL LOADER, consumed via useLoader() inside a
        // cache() boundary — SAFE. The loader is a fresh, never-cached segment;
        // the cached handler renders only the static client-component shell, so
        // the cookie value reflects the current request and is never baked into
        // the shared cached output.
        cache({ ttl: 600 }, () => [
          path(
            "/loader-cookies-allowed",
            () => (
              <div data-testid="csg-loader-cookies-page">
                <CacheScopeGuardCookieReader />
              </div>
            ),
            { name: "loaderCookiesAllowed" },
            () => [loader(CookieReaderLoader)],
          ),
        ]),

        // A loader bound with its own cache() and no key(), whose body reads
        // cookies() — BLOCKED (#972). The entry is keyed by loader, host,
        // path and params, so the first visitor's session would reach every
        // later visitor.
        path(
          "/loader-cache-unkeyed",
          async (ctx) => {
            const { session } = await ctx.use(CachedSessionLoader);
            return (
              <div data-testid="csg-loader-cache-session">
                Should not render: {session}
              </div>
            );
          },
          { name: "loaderCacheUnkeyed" },
          () => [
            loader(CachedSessionLoader, () => [cache({ ttl: 600 })]),
            errorBoundary((props) => (
              <div data-testid="csg-error-page">
                <span data-testid="csg-error-message">
                  {props.error.message}
                </span>
              </div>
            )),
          ],
        ),

        // The same unkeyed binding, read first by a parent layout's handler:
        // the route's MISS reuses that run and fails the same way (#972).
        layout(
          async (ctx) => {
            const { session } = await ctx.use(CachedSessionLoader);
            return (
              <div>
                <span data-testid="csg-layout-session">{session}</span>
                <Outlet />
              </div>
            );
          },
          () => [
            path(
              "/loader-cache-reader-first",
              async (ctx) => {
                const { session } = await ctx.use(CachedSessionLoader);
                return (
                  <div data-testid="csg-loader-cache-session">
                    Should not render: {session}
                  </div>
                );
              },
              { name: "loaderCacheReaderFirst" },
              () => [
                loader(CachedSessionLoader, () => [cache({ ttl: 600 })]),
                errorBoundary((props) => (
                  <div data-testid="csg-error-page">
                    <span data-testid="csg-error-message">
                      {props.error.message}
                    </span>
                  </div>
                )),
              ],
            ),
          ],
        ),

        // The same loader with a key() that includes the cookie — ALLOWED,
        // one entry per session.
        path(
          "/loader-cache-keyed",
          async (ctx) => {
            const { session, stamp } = await ctx.use(CachedSessionLoader);
            return (
              <div>
                <span data-testid="csg-loader-cache-session">{session}</span>
                <span data-testid="csg-loader-cache-stamp">{stamp}</span>
              </div>
            );
          },
          { name: "loaderCacheKeyed" },
          () => [
            loader(CachedSessionLoader, () => [
              cache({
                ttl: 600,
                key: () =>
                  `csg-session:${cookies().get("csg-session")?.value ?? ""}`,
              }),
            ]),
          ],
        ),

        // "use cache" and a non-cacheable var set per request from ?tenant=
        // (issue #925); no cache() boundary.
        middleware(
          async (ctx, next) => {
            ctx.set(
              NonCacheableData,
              ctx.url.searchParams.get("tenant") ?? "none",
            );
            return next();
          },
          () => [
            // getRequestContext().get() inside "use cache" — BLOCKED
            path(
              "/use-cache-read-blocked",
              async () => {
                const label = await getTenantLabelFromVar();
                return <div data-testid="csg-use-cache-value">{label}</div>;
              },
              { name: "useCacheReadBlocked" },
              () => [
                errorBoundary((props) => (
                  <div data-testid="csg-error-page">
                    <span data-testid="csg-error-message">
                      {props.error.message}
                    </span>
                  </div>
                )),
              ],
            ),
            // Read outside, passed in as an argument — ALLOWED, keyed per value
            path(
              "/use-cache-arg-keyed",
              async (ctx) => {
                const tenant = ctx.get(NonCacheableData) ?? "none";
                const entry = await getTenantLabel(tenant);
                return (
                  <div>
                    <span data-testid="csg-use-cache-arg-tenant">
                      {entry.tenant}
                    </span>
                    <span data-testid="csg-use-cache-arg-stamp">
                      {entry.stamp}
                    </span>
                  </div>
                );
              },
              { name: "useCacheArgKeyed" },
            ),
          ],
        ),

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
