import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Test patterns for reverse auto-fill of mount params.
 *
 * These patterns are included under a parameterized prefix:
 *   include("/reverse-autofill/:tenantId", reverseAutofillPatterns, { name: "reverseAutofill" })
 *
 * Handlers use ctx.reverse(".localName") without passing tenantId,
 * which should be auto-filled from ctx.params.
 */
export const reverseAutofillPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      // tenantId comes from include() prefix, not visible to path() types
      const params = ctx.params as Record<string, string>;
      // Auto-fill: tenantId from ctx.params
      const settingsUrl = ctx.reverse(".settings");
      // Mixed: tenantId auto-filled, userId explicit
      const userUrl = ctx.reverse(".user", { userId: "u1" });
      // Override: explicit tenantId replaces auto-filled value
      const overrideUrl = ctx.reverse(".settings", { tenantId: "override" });
      // Global route: tenantId auto-filled for global name too
      const globalSettingsUrl = ctx.reverse("reverseAutofill.settings");

      return (
        <div data-testid="autofill-index-page">
          <h1 data-testid="autofill-index-title">Tenant: {params.tenantId}</h1>
          <ul>
            <li data-testid="autofill-settings-url">{settingsUrl}</li>
            <li data-testid="autofill-user-url">{userUrl}</li>
            <li data-testid="autofill-override-url">{overrideUrl}</li>
            <li data-testid="autofill-global-settings-url">
              {globalSettingsUrl}
            </li>
          </ul>
          <nav>
            <Link to={settingsUrl} data-testid="autofill-link-settings">
              Settings
            </Link>
            {" | "}
            <Link to={userUrl} data-testid="autofill-link-user">
              User u1
            </Link>
          </nav>
        </div>
      );
    },
    { name: "index" },
  ),

  path(
    "/settings",
    (ctx) => {
      // tenantId comes from include() prefix, not visible to path() types
      const params = ctx.params as Record<string, string>;
      // Auto-fill: tenantId from ctx.params
      const indexUrl = ctx.reverse(".index");
      const userUrl = ctx.reverse(".user", { userId: "u2" });

      return (
        <div data-testid="autofill-settings-page">
          <h1 data-testid="autofill-settings-title">
            Settings for: {params.tenantId}
          </h1>
          <ul>
            <li data-testid="autofill-back-index-url">{indexUrl}</li>
            <li data-testid="autofill-settings-user-url">{userUrl}</li>
          </ul>
          <nav>
            <Link to={indexUrl} data-testid="autofill-link-back-index">
              Back to Index
            </Link>
          </nav>
        </div>
      );
    },
    { name: "settings" },
  ),

  path(
    "/users/:userId",
    (ctx) => {
      // tenantId comes from include() prefix, not visible to path() types
      const params = ctx.params as Record<string, string>;
      // Auto-fill: tenantId from ctx.params, userId also in ctx.params
      const settingsUrl = ctx.reverse(".settings");
      const indexUrl = ctx.reverse(".index");
      // Another user: tenantId auto-filled, userId explicit
      const otherUserUrl = ctx.reverse(".user", { userId: "other" });

      return (
        <div data-testid="autofill-user-page">
          <h1 data-testid="autofill-user-title">
            User: {params.userId} (tenant: {params.tenantId})
          </h1>
          <ul>
            <li data-testid="autofill-user-settings-url">{settingsUrl}</li>
            <li data-testid="autofill-user-index-url">{indexUrl}</li>
            <li data-testid="autofill-user-other-url">{otherUserUrl}</li>
          </ul>
          <nav>
            <Link to={indexUrl} data-testid="autofill-link-user-back">
              Back to Index
            </Link>
            {" | "}
            <Link to={settingsUrl} data-testid="autofill-link-user-settings">
              Settings
            </Link>
          </nav>
        </div>
      );
    },
    { name: "user" },
  ),
]);
