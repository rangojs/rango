import { Static, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A Static() layout inside a NESTED include: its scope prefix is
// `nestedMount.admin`, and its `.settings` link must resolve in that module in
// a build exactly as the live handler does in dev. The bake used to read the
// prefix as a route name, drop the last segment and fail the build with
// `Unknown route: ".settings" (current route: nestedMount.admin)`.
export const NestedMountNav = Static((ctx) => (
  <div data-testid="nested-mount-layout">
    <nav data-testid="nested-mount-nav">
      <Link
        to={ctx.reverse(".settings")}
        data-testid="nested-mount-settings-link"
      >
        settings
      </Link>
    </nav>
    <Outlet />
  </div>
));

function NestedMountSettingsPage() {
  return <div data-testid="nested-mount-page">nested settings</div>;
}

const nestedMountAdmin = urls(({ path, layout }) => [
  layout(NestedMountNav, () => [
    path("/settings", NestedMountSettingsPage, { name: "settings" }),
  ]),
]);

// One named include inside another: the app mounts this module at
// `/nested-mount` with `{ name: "nestedMount" }`, so the route name is
// `nestedMount.admin.settings`.
export const nestedMountScope = urls(({ include }) => [
  include("/admin", nestedMountAdmin, { name: "admin" }),
]);
