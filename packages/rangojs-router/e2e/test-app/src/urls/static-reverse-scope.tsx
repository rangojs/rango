import { urls, Static } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the module
 * that declares it, exactly as the same segment renders live.
 *
 * Mounted in urls.tsx as
 *   include("/static-reverse-scope", staticReverseScopePatterns, { name: "" })
 * — a transparent include, so the module's own layout sits at root scope with
 * no name prefix. Below it, account (`account`) holds project (`account.project`)
 * and both declare a route named "settings", so each dot name has a different
 * right answer at every depth. The path prefixes are literals: a baked handler
 * has no request params to autofill.
 */

// Root scope: no named include above, so no name prefix. Before the fix the
// bake threw `Unknown route: ".home"` here. The catch keeps a build that cannot
// resolve the name from failing outright — the e2e pins the URL, so an
// unresolved name must show up in the DOM rather than as a dead build.
export const SrsRootLayout = Static((ctx) => {
  let home: string;
  try {
    home = ctx.reverse(".srsHome");
  } catch {
    home = "unresolved";
  }
  return (
    <div data-testid="srs-root-layout">
      <span data-testid="srs-root-home">{home}</span>
      <Outlet />
    </div>
  );
});

// Prefix "account": `.settings` is the account module's route.
export const SrsAccountLayout = Static((ctx) => (
  <div data-testid="srs-account-layout">
    <span data-testid="srs-account-settings">{ctx.reverse(".settings")}</span>
    <Outlet />
  </div>
));

// Prefix "account.project": `.settings` is the project module's route. Before
// the fix the bake resolved it from "account" and linked to the account page.
export const SrsProjectLayout = Static((ctx) => (
  <div data-testid="srs-project-layout">
    <span data-testid="srs-project-settings">{ctx.reverse(".settings")}</span>
    <Outlet />
  </div>
));

// A parallel slot declared in the project module resolves there too.
export const SrsProjectBadge = Static((ctx) => (
  <aside data-testid="srs-project-slot">
    <span data-testid="srs-slot-settings">{ctx.reverse(".settings")}</span>
  </aside>
));

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(SrsProjectLayout, () => [
    path(
      "/settings",
      () => <p data-testid="srs-project-settings-page">project settings</p>,
      {
        name: "settings",
      },
    ),
    path(
      "/issues",
      () => (
        <div data-testid="srs-project-issues">
          <ParallelOutlet name="@badge" />
        </div>
      ),
      { name: "issues" },
      () => [parallel({ "@badge": SrsProjectBadge })],
    ),
  ]),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(SrsAccountLayout, () => [
    path(
      "/settings",
      () => <p data-testid="srs-account-settings-page">account settings</p>,
      {
        name: "settings",
      },
    ),
    include("/web", projectPatterns, { name: "srsProject" }),
  ]),
]);

export const staticReverseScopePatterns = urls(({ path, layout, include }) => [
  layout(SrsRootLayout, () => [
    path(
      "/",
      () => (
        <p data-testid="srs-home">
          <Link
            to="/static-reverse-scope/acme/web/issues"
            data-testid="srs-to-issues"
          >
            issues
          </Link>
        </p>
      ),
      { name: "srsHome" },
    ),
    include("/acme", accountPatterns, { name: "srsAccount" }),
  ]),
]);
