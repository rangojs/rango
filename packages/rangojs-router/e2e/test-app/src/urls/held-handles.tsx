import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { heldHandlesTargetAction } from "./held-handles.actions.js";
import {
  HeldHandlesActionsBar,
  HeldHandlesCrumbs,
  HeldHandlesView,
} from "./held-handles.client.js";
import {
  HeldCrumbs,
  HeldHandlesHeldLoader,
  HeldHandlesRerunLoader,
} from "./held-handles.defs.js";

// Server-tree twin of held-handles.client-urls.tsx (e2e held-handles.test.ts):
// the same two loaders on an ordinary urls() route, the held one skipped by a
// server revalidate() on any action but the target. The route handler pushes
// a crumb of its own and reruns on every action.
function HeldHandlesServerLayout() {
  return (
    <section data-testid="hh-server-layout">
      <HeldHandlesActionsBar />
      <HeldHandlesCrumbs />
      <Outlet />
    </section>
  );
}

export const heldHandlesPatterns = urls(
  ({ layout, path, loader, revalidate }) => [
    layout(HeldHandlesServerLayout, () => [
      path(
        "/held-handles-server",
        (ctx) => {
          ctx.use(HeldCrumbs)("handler");
          return <HeldHandlesView />;
        },
        { name: "heldHandlesServer" },
        () => [
          loader(HeldHandlesHeldLoader, () => [
            revalidate(({ isAction }) =>
              isAction() ? isAction(heldHandlesTargetAction) : undefined,
            ),
          ]),
          loader(HeldHandlesRerunLoader),
        ],
      ),
    ]),
  ],
);
