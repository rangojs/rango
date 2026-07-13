import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Hash navigation test routes — verifies that hash-only links
 * bypass the SPA router and use native browser anchor behavior.
 */
export const hashNavigationPatterns = urls(({ path }) => [
  path(
    "/",
    () => (
      <div data-testid="hash-nav-page">
        <h1>Hash Navigation Test</h1>
        <nav data-testid="hash-nav-links">
          <ul>
            <li>
              <Link
                to="#section-a"
                prefetch="viewport"
                data-testid="link-hash-a"
              >
                Jump to Section A (Link)
              </Link>
            </li>
            <li>
              <Link to="#section-b" data-testid="link-hash-b">
                Jump to Section B (Link)
              </Link>
            </li>
            <li>
              <a href="#section-a" data-testid="anchor-hash-a">
                Jump to Section A (anchor)
              </a>
            </li>
            <li>
              <Link to="/blog" data-testid="link-different-path">
                Go to Blog (different path)
              </Link>
            </li>
          </ul>
        </nav>

        <div style={{ height: "200px" }} />

        <section id="section-a" data-testid="section-a">
          <h2>Section A</h2>
          <p>Content for section A</p>
        </section>

        <div style={{ height: "200px" }} />

        <section id="section-b" data-testid="section-b">
          <h2>Section B</h2>
          <p>Content for section B</p>
        </section>

        <div style={{ height: "2000px" }} aria-hidden="true" />
        <Link to="/blog/post-5" data-testid="link-default-prefetch-offscreen">
          Offscreen default-prefetch link
        </Link>
        <a href="/blog/post-6" data-testid="anchor-default-prefetch-offscreen">
          Offscreen default-prefetch plain anchor
        </a>
        <a
          href="/blog/post-7"
          data-prefetch="false"
          data-testid="anchor-prefetch-opt-out"
        >
          Prefetch opt-out plain anchor
        </a>
        <a
          href="/blog/post-8"
          data-prefetch="none"
          data-testid="anchor-prefetch-none"
        >
          Strategy-style prefetch opt-out plain anchor
        </a>
        <a href="/files/report.pdf" data-testid="anchor-prefetch-resource">
          Static resource plain anchor
        </a>
        <a
          href="/blog/intro-to-node.js"
          data-prefetch="true"
          data-testid="anchor-prefetch-resource-route"
        >
          Static-looking application route
        </a>
        <a
          href="/blog/50%off"
          data-prefetch="true"
          data-testid="anchor-prefetch-malformed-route"
        >
          Malformed-percent application route
        </a>
        <svg aria-label="SVG link fixture">
          <a href="/blog/svg-link" data-testid="svg-prefetch-link">
            <circle cx="5" cy="5" r="5" />
          </a>
        </svg>
      </div>
    ),
    { name: "index" },
  ),
]);
