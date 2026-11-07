import { Static } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// One Static() layout and one Static() parallel slot, each exported once and
// mounted in several include() scopes (static-mounts-urls.tsx). Each mount
// links `.settings` in its own module, in a build exactly as in dev.

export const StaticMountNav = Static((ctx) => (
  <div data-testid="static-mount-layout">
    <a data-testid="static-mount-nav-link" href={ctx.reverse(".settings")}>
      Settings
    </a>
    <ParallelOutlet name="@side" />
    <Outlet />
  </div>
));

export const StaticMountSide = Static((ctx) => (
  <a data-testid="static-mount-side-link" href={ctx.reverse(".settings")}>
    Side settings
  </a>
));
