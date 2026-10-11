"use client";

import { clientUrls, useOutlet } from "@rangojs/router/client";
import * as HeldHandlesActions from "./held-handles.actions.js";
import { heldHandlesTargetAction } from "./held-handles.actions.js";
import {
  HeldHandlesActionsBar,
  HeldHandlesCrumbs,
  HeldHandlesView,
} from "./held-handles.client.js";
import {
  HeldHandlesHeldLoader,
  HeldHandlesRerunLoader,
} from "./held-handles.defs.js";

function HeldHandlesClientLayout() {
  const { content } = useOutlet();
  return (
    <section data-testid="hh-client-layout">
      <HeldHandlesActionsBar />
      <HeldHandlesCrumbs />
      {content}
    </section>
  );
}

// The issue's predicate: on an action, rerun only for the module's target
// action; otherwise keep the locked default.
export default clientUrls(({ layout, path, loader, revalidate }) => [
  layout(HeldHandlesClientLayout, () => [
    path("/", HeldHandlesView, { name: "index" }, () => [
      loader(HeldHandlesHeldLoader, () => [
        revalidate(({ isAction }) =>
          isAction() ? isAction(heldHandlesTargetAction) : undefined,
        ),
      ]),
      loader(HeldHandlesRerunLoader, () => [
        revalidate(({ isAction }) =>
          isAction() ? isAction(HeldHandlesActions) : undefined,
        ),
      ]),
    ]),
  ]),
]);
