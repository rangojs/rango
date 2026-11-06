import { Static, urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or parallel slot bakes ctx.reverse(".name") in the module
 * that declares it, as the same segment resolves it live.
 *
 * Mounted in urls.tsx as
 *   include("/srs", staticReverseScopePatterns, { name: "" })
 * so the outer layout and its slot are at root scope (no named include). It
 * holds an account module at /:accountId holding a project module at
 * /:projectId; both name a route "settings". Every segment links with
 * explicit params, since a Static() handler has none at build time.
 */
const PARAMS = { accountId: "acme", projectId: "web" };

export const SrsRootShell = Static((ctx) => (
  <div data-testid="srs-root-layout">
    <span data-testid="srs-root-index-url">{ctx.reverse(".srsIndex")}</span>
    <ParallelOutlet name="@aside" />
    <Outlet />
  </div>
));

export const SrsRootAside = Static((ctx) => (
  <span data-testid="srs-root-slot-url">{ctx.reverse(".srsIndex")}</span>
));

export const SrsAccountShell = Static((ctx) => (
  <div data-testid="srs-account-layout">
    <span data-testid="srs-account-settings-url">
      {ctx.reverse(".settings", PARAMS)}
    </span>
    <Outlet />
  </div>
));

export const SrsProjectShell = Static((ctx) => (
  <div data-testid="srs-project-layout">
    <span data-testid="srs-project-settings-url">
      {ctx.reverse(".settings", PARAMS)}
    </span>
    <ParallelOutlet name="@aside" />
    <Outlet />
  </div>
));

export const SrsProjectAside = Static((ctx) => (
  <span data-testid="srs-project-slot-url">
    {ctx.reverse(".settings", PARAMS)}
  </span>
));

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(SrsProjectShell, () => [
    parallel({ "@aside": SrsProjectAside }),
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
  layout(SrsAccountShell, () => [
    path(
      "/settings",
      () => <div data-testid="srs-account-settings-page">Account settings</div>,
      { name: "settings" },
    ),
    include("/:projectId", projectPatterns, { name: "project" }),
  ]),
]);

export const staticReverseScopePatterns = urls(
  ({ path, layout, parallel, include }) => [
    layout(SrsRootShell, () => [
      parallel({ "@aside": SrsRootAside }),
      path(
        "/",
        () => (
          <div data-testid="srs-index">
            <Link to="/srs/acme/web/issues" data-testid="srs-to-issues">
              Project issues
            </Link>
          </div>
        ),
        { name: "srsIndex" },
      ),
      include("/:accountId", accountPatterns, { name: "srsAccount" }),
    ]),
  ],
);
