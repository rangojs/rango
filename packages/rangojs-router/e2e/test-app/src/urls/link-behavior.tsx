import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Link behavior test routes — tests for data-no-intercept, prefetch
 * strategies (hover, viewport, render), and interception edge cases.
 */
export const linkBehaviorPatterns = urls(({ path }) => [
  path(
    "/",
    () => (
      <div data-testid="link-behavior-page">
        <h1>Link Behavior Tests</h1>

        <section data-testid="interception-tests">
          <h2>Interception</h2>
          <ul>
            <li>
              <a
                href="/blog"
                data-no-intercept="true"
                data-testid="anchor-no-intercept"
              >
                Blog (data-no-intercept, should full-reload)
              </a>
            </li>
            <li>
              <a
                href="/blog"
                data-prefetch="false"
                data-testid="anchor-intercepted"
              >
                Blog (should SPA navigate)
              </a>
            </li>
            <li>
              <a
                href="/blog?cross-tab-delegated=1"
                data-prefetch="false"
                data-testid="cross-tab-delegated-navigation"
              >
                Blog (cross-tab delegated navigation fixture)
              </a>
            </li>
          </ul>
        </section>

        <section data-testid="prefetch-tests">
          <h2>Prefetch Strategies</h2>
          <ul>
            <li>
              <Link
                to="/blog"
                prefetch="hover"
                data-testid="link-prefetch-hover"
              >
                Blog (prefetch on hover)
              </Link>
            </li>
            <li>
              <Link
                to="/blog/post-1"
                prefetch="render"
                data-testid="link-prefetch-render"
              >
                Blog Post (prefetch on render)
              </Link>
            </li>
            <li>
              <Link
                to="/blog/post-2"
                prefetch="none"
                data-testid="link-prefetch-none"
              >
                Blog Post 2 (no prefetch)
              </Link>
            </li>
            <li>
              <Link
                to="/blog/post-3"
                prefetch="viewport"
                data-testid="link-prefetch-viewport"
              >
                Blog Post 3 (prefetch on viewport)
              </Link>
            </li>
            <li>
              <Link
                to="/blog/post-4"
                prefetch="adaptive"
                data-testid="link-prefetch-adaptive"
              >
                Blog Post 4 (prefetch adaptive)
              </Link>
            </li>
          </ul>
        </section>
      </div>
    ),
    { name: "index" },
  ),

  // data-external SSR/browser agreement: the server must classify absolute
  // URLs against the REQUEST origin, exactly as the browser will against
  // window.location.origin. Regression fixture for the swallowed-window bug
  // where SSR never emitted data-external and every absolute-URL Link was a
  // hydration mismatch (cross-origin ones then hard-navigated only after
  // the client patched the attribute in).
  path(
    "/external-origin",
    (ctx) => (
      <div data-testid="link-external-origin-page">
        <h1>Absolute-URL Link classification</h1>
        <ul>
          <li>
            <Link
              to="https://external.example.com/promo"
              data-testid="link-cross-origin"
            >
              Cross-origin absolute (data-external in SSR HTML)
            </Link>
          </li>
          <li>
            {/* Same-site absolute: built from the live request origin, so it
                is same-origin on whatever host/port serves the test. */}
            <Link
              to={`${ctx.url.origin}/blog`}
              data-testid="link-same-origin-absolute"
            >
              Same-origin absolute (soft navigation, no data-external)
            </Link>
          </li>
          <li>
            <Link to="/blog" data-testid="link-relative-control">
              Relative control
            </Link>
          </li>
        </ul>
      </div>
    ),
    { name: "externalOrigin" },
  ),
]);
