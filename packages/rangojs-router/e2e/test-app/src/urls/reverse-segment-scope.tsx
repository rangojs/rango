import { urls, type HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

/**
 * A segment's ctx.reverse(".name") resolves in the module that defines it.
 *
 * Mounted in urls.tsx as
 *   include("/reverse-scope", reverseSegmentScopePatterns, { name: "reverseScope" })
 * with an account module at /:accountId holding a project module at
 * /:projectId. Both modules name a route "settings": the account layout's
 * `.settings` must link to the account route on every page below it,
 * including the project's pages, while the project route's own `.settings`
 * links to the project route.
 */
/** A server component the account layout hands its ctx to; renders later. */
async function AccountChildLink({ ctx }: { ctx: HandlerContext }) {
  await Promise.resolve();
  return (
    <span data-testid="rss-account-child-url">{ctx.reverse(".settings")}</span>
  );
}

const projectPatterns = urls(({ path }) => [
  path(
    "/issues",
    (ctx) => (
      <div data-testid="rss-project-issues">
        <p data-testid="rss-project-settings-url">{ctx.reverse(".settings")}</p>
      </div>
    ),
    { name: "issues" },
  ),
  path(
    "/settings",
    () => <div data-testid="rss-project-settings-page">Project settings</div>,
    { name: "settings" },
  ),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(
    (ctx) => {
      const settingsUrl = ctx.reverse(".settings");
      return (
        <div data-testid="rss-account-layout">
          <nav>
            <span data-testid="rss-account-settings-url">{settingsUrl}</span>
            <Link to={settingsUrl} data-testid="rss-account-settings-link">
              Account settings
            </Link>
            <AccountChildLink ctx={ctx} />
          </nav>
          <Outlet />
        </div>
      );
    },
    () => [
      path(
        "/settings",
        () => (
          <div data-testid="rss-account-settings-page">Account settings</div>
        ),
        { name: "settings" },
      ),
      include("/:projectId", projectPatterns, { name: "project" }),
    ],
  ),
]);

export const reverseSegmentScopePatterns = urls(({ path, include }) => [
  path(
    "/",
    () => (
      <div data-testid="rss-index">
        <Link to="/reverse-scope/acme/web/issues" data-testid="rss-to-issues">
          Project issues
        </Link>
      </div>
    ),
    { name: "index" },
  ),
  include("/:accountId", accountPatterns, { name: "account" }),
]);
