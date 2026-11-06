import { Static, urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or slot bakes ctx.reverse(".name") in the module that
 * defines it, at every nesting depth.
 *
 * Mounted in urls.tsx as
 *   include("/static-scope", staticReverseScopePatterns, { name: "" })
 * so the root layout sits at root scope (no name prefix). Below it an account
 * module holds a project module; both name a route "settings". The build used
 * to hand the def's name prefix to resolveRouteName, which strips one more
 * segment: the project layout baked the account route (/static-scope/acme/
 * settings) instead of the project one, and the root layout had no prefix at
 * all and threw "Unknown route" for ".staticScopeHome" at build.
 */
export const StaticRootLayout = Static((ctx) => {
  const homeUrl = ctx.reverse(".staticScopeHome");
  return (
    <div data-testid="srs-root-layout" data-home-url={homeUrl}>
      <Outlet />
    </div>
  );
});

export const StaticAccountLayout = Static((ctx) => {
  const settingsUrl = ctx.reverse(".settings");
  return (
    <div data-testid="srs-account-layout">
      <p data-testid="srs-account-settings-url">{settingsUrl}</p>
      <Outlet />
    </div>
  );
});

export const StaticProjectLayout = Static((ctx) => {
  const settingsUrl = ctx.reverse(".settings");
  return (
    <div data-testid="srs-project-layout">
      <p data-testid="srs-project-settings-url">{settingsUrl}</p>
      <ParallelOutlet name="@aside" />
      <Outlet />
    </div>
  );
});

export const StaticProjectSlot = Static((ctx) => {
  const settingsUrl = ctx.reverse(".settings");
  return <aside data-testid="srs-project-slot">{settingsUrl}</aside>;
});

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(StaticProjectLayout, () => [
    parallel({ "@aside": StaticProjectSlot }),
    path(
      "/issues",
      () => <div data-testid="srs-project-issues">Project issues</div>,
      { name: "issues" },
    ),
    path(
      "/settings",
      () => <div data-testid="srs-project-settings-page">Project settings</div>,
      { name: "settings" },
    ),
  ]),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(StaticAccountLayout, () => [
    path(
      "/settings",
      () => <div data-testid="srs-account-settings-page">Account settings</div>,
      { name: "settings" },
    ),
    include("/web", projectPatterns, { name: "project" }),
  ]),
]);

export const staticReverseScopePatterns = urls(({ path, layout, include }) => [
  layout(StaticRootLayout, () => [
    path(
      "/",
      (ctx) => (
        <div data-testid="srs-index">
          <Link
            to={ctx.reverse("staticAccount.project.issues")}
            data-testid="srs-to-issues"
          >
            Project issues
          </Link>
        </div>
      ),
      { name: "staticScopeHome" },
    ),
    include("/acme", accountPatterns, { name: "staticAccount" }),
  ]),
]);
