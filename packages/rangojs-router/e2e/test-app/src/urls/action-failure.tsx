import type { ReactNode } from "react";
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  ActionFailureDataPage,
  ActionFailureThrowPage,
} from "./action-failure.client.js";
import {
  ActionFailureDataLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";

// urls() twin of action-failure.client-urls.tsx (action-failure.test.ts).
export const actionFailurePatterns = urls(({ path, loader }) => [
  path(
    "/throw",
    () => <ActionFailureThrowPage />,
    { name: "throw" },
    () => [loader(ActionFailureThrowLoader)],
  ),
  path(
    "/data",
    () => <ActionFailureDataPage />,
    { name: "data" },
    () => [loader(ActionFailureDataLoader)],
  ),
]);

// The layout and errorBoundary() a second mount of the group sits under.
export function ActionFailureBoundedLayout(): ReactNode {
  return <Outlet />;
}

export function ActionFailureErrorBoundary(): ReactNode {
  return <p data-testid="af-error-boundary">The page failed to load</p>;
}
