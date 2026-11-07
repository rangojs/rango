import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { StaticMountNav, StaticMountSide } from "./static-mounts.js";

function SettingsPage() {
  return (
    <div data-testid="static-mount-settings">
      <Link to="/static-mounts/b/settings" data-testid="static-mount-to-b">
        To b
      </Link>
    </div>
  );
}

const staticMountModule = urls(({ path, layout, parallel }) => [
  layout(StaticMountNav, () => [
    parallel({ "@side": StaticMountSide }),
    path("/settings", SettingsPage, { name: "settings" }),
  ]),
]);

// The same module mounted under "a", "b" and the nested "outer.inner".
export const staticMountsPatterns = urls(({ include }) => [
  include("/a", staticMountModule, { name: "a" }),
  include("/b", staticMountModule, { name: "b" }),
  include(
    "/outer",
    urls(({ include }) => [
      include("/inner", staticMountModule, { name: "inner" }),
    ]),
    { name: "outer" },
  ),
]);
