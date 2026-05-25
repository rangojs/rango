import { Outlet, Link } from "@rangojs/router/client";
import { KeyRefreshWidget } from "./KeyRefreshWidget.js";

/**
 * Lifecycle layout for the key-refresh bucket-lifecycle tests.
 *
 * The "persist" widget lives in the layout, OUTSIDE the outlet, so it stays
 * mounted across navigations between the two children — its ephemeral keyed
 * bucket must survive (not blank out). The "scoped" widget lives inside the /a
 * child (see urls/key-refresh.tsx); it unmounts on navigation, so its bucket is
 * reclaimed by refcount and resets when revisited.
 */
export function KeyRefreshLifeLayout() {
  return (
    <div data-testid="key-refresh-life-layout">
      <KeyRefreshWidget id="persist" loaderKey="life" />
      <nav>
        <Link to="/key-refresh-life/a" data-testid="key-refresh-life-link-a">
          A
        </Link>
        <Link to="/key-refresh-life/b" data-testid="key-refresh-life-link-b">
          B
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
