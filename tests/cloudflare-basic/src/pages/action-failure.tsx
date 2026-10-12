import type { ReactNode } from "react";
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  ActionFailureBoundedControls,
  ActionFailureDataPage,
  ActionFailureItemPage,
  ActionFailureItemsPage,
  ActionFailureLoading,
  ActionFailureThrowPage,
} from "./action-failure.client.js";
import {
  ActionFailureDataLoader,
  ActionFailureRevisionLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";
import { ActionFailureItemLoader } from "./action-failure.item-loader.js";

// urls() twin of action-failure.client-urls.tsx (e2e/action-failure.test.ts).
export const actionFailurePatterns = urls(
  ({ path, layout, loader, loading }) => [
    path(
      "/throw",
      () => <ActionFailureThrowPage />,
      { name: "throw" },
      () => [
        loader(ActionFailureThrowLoader),
        loader(ActionFailureRevisionLoader),
      ],
    ),
    path(
      "/throw-loading",
      () => <ActionFailureThrowPage />,
      { name: "throwLoading" },
      () => [
        loader(ActionFailureThrowLoader),
        loader(ActionFailureRevisionLoader),
        loading(<ActionFailureLoading />),
      ],
    ),
    path(
      "/data",
      () => <ActionFailureDataPage />,
      { name: "data" },
      () => [loader(ActionFailureDataLoader)],
    ),
    // A delete action whose item loader then throws redirect(): the layout
    // keeps its instance across the action and the redirect.
    layout(ActionFailureItemsLayout, () => [
      path("/items", () => <ActionFailureItemsPage />, { name: "items" }),
      path(
        "/items/:id",
        () => <ActionFailureItemPage />,
        { name: "item" },
        () => [loader(ActionFailureItemLoader)],
      ),
    ]),
  ],
);

// The layout and errorBoundary() a second mount of the group sits under. Its
// controls stay when the boundary's fallback replaces the group.
export function ActionFailureBoundedLayout(): ReactNode {
  return (
    <>
      <ActionFailureBoundedControls />
      <Outlet />
    </>
  );
}

export function ActionFailureErrorBoundary(): ReactNode {
  return <p data-testid="af-error-boundary">The page failed to load</p>;
}

export function ActionFailureItemsLayout(): ReactNode {
  return (
    <section data-testid="af-items-layout">
      <Outlet />
    </section>
  );
}
