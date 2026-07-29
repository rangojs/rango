import { Link } from "@rangojs/router/client";
import type { HandlerContext } from "@rangojs/router";

/**
 * data-external SSR/browser agreement fixture (mirror of the test-app's
 * /link-behavior/external-origin): the server must classify absolute URLs
 * against the REQUEST origin, exactly as the browser will against
 * window.location.origin. Regression for the swallowed-window bug where SSR
 * never emitted data-external and every absolute-URL Link was a hydration
 * mismatch on workerd too.
 */
export function LinkExternalOriginPage(ctx: HandlerContext) {
  return (
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
          {/* Same-site absolute: built from the live request origin, so it is
              same-origin on whatever host/port serves the test. */}
          <Link
            to={`${ctx.url.origin}/about`}
            data-testid="link-same-origin-absolute"
          >
            Same-origin absolute (soft navigation, no data-external)
          </Link>
        </li>
        <li>
          <Link to="/about" data-testid="link-relative-control">
            Relative control
          </Link>
        </li>
      </ul>
    </div>
  );
}
