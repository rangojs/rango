import { Static, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

// One Static() definition mounted in two include() scopes. Its `.settings` link
// must resolve in the scope of the mount it renders at, exactly as the live
// handler does in dev: the build stores one artifact per (definition, mount
// scope), keyed at the DSL position (stampStaticDefScope/staticArtifactKey).
// Keyed by the definition alone, both mounts served the artifact baked in the
// LAST mount's scope, so the first mount's link pointed into the second's
// module.
export const SharedMountNav = Static((ctx) => (
  <nav data-testid="shared-mount-nav">
    <Link
      to={ctx.reverse(".settings")}
      data-testid="shared-mount-settings-link"
    >
      settings
    </Link>
  </nav>
));

// A parallel slot from the same single definition, mounted in both scopes too.
export const SharedMountAside = Static((ctx) => (
  <aside data-testid="shared-mount-aside">
    <Link to={ctx.reverse(".settings")} data-testid="shared-mount-aside-link">
      settings
    </Link>
  </aside>
));

function SharedMountSettingsPage() {
  return <div data-testid="shared-mount-page">settings</div>;
}

const mountScopeA = urls(({ path, layout, parallel }) => [
  layout(SharedMountNav, () => [
    path("/settings", SharedMountSettingsPage, { name: "settings" }, () => [
      parallel({ "@aside": SharedMountAside }),
    ]),
  ]),
]);

const mountScopeB = urls(({ path, layout, parallel }) => [
  layout(SharedMountNav, () => [
    path("/settings", SharedMountSettingsPage, { name: "settings" }, () => [
      parallel({ "@aside": SharedMountAside }),
    ]),
  ]),
]);

export const staticSharedMountPatterns = urls(({ include }) => [
  include("/shared-mount-a", mountScopeA, { name: "sharedMountA" }),
  include("/shared-mount-b", mountScopeB, { name: "sharedMountB" }),
]);
