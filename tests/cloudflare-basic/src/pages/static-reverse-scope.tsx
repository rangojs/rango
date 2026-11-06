import { urls, Static } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the
 * include scope it was mounted in, exactly as the same layout resolves it
 * live — at every nesting depth, the root included.
 *
 * Mounted in urls.tsx as include("/static-reverse", staticReverseScopePatterns,
 * { name: "" }) — a transparent include, so the root layout sits at root
 * scope and its `.staticReverseHome` resolves through the bare-name fallback.
 * Below it an account module at /:accountId holds a project module at
 * /:projectId; both name a route "settings", and the account also names
 * "billing" so the project layout's `.billing` exercises the walk-up to an
 * enclosing include.
 *
 * Every reverse call passes its params explicitly: a bake has no request
 * params to autofill, so the same call is the only one that can agree in dev
 * and in a build.
 */
const ACCOUNT_PARAMS = { accountId: "acme" };
const PROJECT_PARAMS = { accountId: "acme", projectId: "web" };

export const StaticReverseRootLayout = Static((ctx) => (
  <div data-testid="srs-root-layout">
    <p data-testid="srs-root-home">{ctx.reverse(".staticReverseHome")}</p>
    <Outlet />
  </div>
));

export const StaticReverseAccountLayout = Static((ctx) => (
  <div data-testid="srs-account-layout">
    <p data-testid="srs-account-settings">
      {ctx.reverse(".settings", ACCOUNT_PARAMS)}
    </p>
    <Outlet />
  </div>
));

export const StaticReverseProjectLayout = Static((ctx) => (
  <div data-testid="srs-project-layout">
    <p data-testid="srs-project-settings">
      {ctx.reverse(".settings", PROJECT_PARAMS)}
    </p>
    <p data-testid="srs-project-billing">
      {ctx.reverse(".billing", ACCOUNT_PARAMS)}
    </p>
    <Link
      to={ctx.reverse(".settings", PROJECT_PARAMS)}
      data-testid="srs-project-settings-link"
    >
      project settings
    </Link>
    <Outlet />
  </div>
));

export const StaticReverseProjectSlot = Static((ctx) => (
  <aside data-testid="srs-project-slot">
    {ctx.reverse(".settings", PROJECT_PARAMS)}
  </aside>
));

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(StaticReverseProjectLayout, () => [
    path(
      "/issues",
      () => (
        <div data-testid="srs-project-issues">
          issues
          <ParallelOutlet name="@aside" />
        </div>
      ),
      { name: "issues" },
      () => [parallel({ "@aside": StaticReverseProjectSlot })],
    ),
    path(
      "/settings",
      () => <div data-testid="srs-project-settings-page">project settings</div>,
      { name: "settings" },
    ),
  ]),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(StaticReverseAccountLayout, () => [
    path(
      "/settings",
      () => <div data-testid="srs-account-settings-page">account settings</div>,
      { name: "settings" },
    ),
    path(
      "/billing",
      () => <div data-testid="srs-account-billing-page">billing</div>,
      { name: "billing" },
    ),
    include("/:projectId", projectPatterns, { name: "project" }),
  ]),
]);

export const staticReverseScopePatterns = urls(({ path, layout, include }) => [
  layout(StaticReverseRootLayout, () => [
    path("/", () => <div data-testid="srs-index">index</div>, {
      name: "staticReverseHome",
    }),
    include("/:accountId", accountPatterns, { name: "account" }),
  ]),
]);
