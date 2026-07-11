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
              <Link to="#section-a" data-testid="link-hash-a">
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
      </div>
    ),
    { name: "index" },
  ),
]);
