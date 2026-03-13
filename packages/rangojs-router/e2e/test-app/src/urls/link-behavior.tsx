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
              <a href="/blog" data-testid="anchor-intercepted">
                Blog (should SPA navigate)
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
]);
