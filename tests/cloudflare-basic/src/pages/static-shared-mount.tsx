import { Static, urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

// One Static() definition mounted in two include() scopes. Its `.settings` link
// must resolve in the scope of the mount it renders at, exactly as the live
// handler does in dev: the build stores one artifact per (definition, mount
// scope), keyed at the DSL position (stampStaticDefScope/staticArtifactKey).
// Keyed by the definition alone, both mounts served the artifact baked in the
// LAST mount's scope, so the first mount's link pointed into the second's
// module.
export const SharedMountNav = Static((ctx) => (
  <div data-testid="shared-mount-layout">
    <nav data-testid="shared-mount-nav">
      <Link
        to={ctx.reverse(".settings")}
        data-testid="shared-mount-settings-link"
      >
        settings
      </Link>
    </nav>
    <Outlet />
  </div>
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
  return (
    <div data-testid="shared-mount-page">
      settings
      <ParallelOutlet name="@aside" />
    </div>
  );
}

// The same definitions mounted in two include() scopes: mount each module at a
// concrete prefix (a transparent include("/") would hide the nested prefixes
// from the route trie in an app with a root catch-all).
export const sharedMountScopeA = urls(({ path, layout, parallel }) => [
  layout(SharedMountNav, () => [
    path("/settings", SharedMountSettingsPage, { name: "settings" }, () => [
      parallel({ "@aside": SharedMountAside }),
    ]),
  ]),
]);

export const sharedMountScopeB = urls(({ path, layout, parallel }) => [
  layout(SharedMountNav, () => [
    path("/settings", SharedMountSettingsPage, { name: "settings" }, () => [
      parallel({ "@aside": SharedMountAside }),
    ]),
  ]),
]);
