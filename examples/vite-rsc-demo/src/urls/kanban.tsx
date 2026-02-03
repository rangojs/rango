import { urls } from "@rangojs/router/server";
import { Outlet } from "@rangojs/router/client";
import {
  KanbanLayout,
  KanbanIndexPage,
  KanbanCardPage,
  kanbanErrorBoundary,
} from "../pages/kanban.js";
import {
  ActionCounterLoader,
  KanbanLoader,
  CardDetailLoader,
} from "../handlers/kanban/loader.js";

export const kanbanPatterns = urls(({ path, layout, loader, revalidate, errorBoundary }) => [
  // Passthrough layout for error boundary
  layout(<Outlet />, () => [
    errorBoundary(kanbanErrorBoundary),
    layout(<KanbanLayout />, () => [
      // Action counter loader for tracking revalidation
      loader(ActionCounterLoader, () => [
        revalidate(({ actionId, stale }) => {
          return actionId?.includes("kanban/actions") ?? stale ?? false;
        }),
      ]),

      // Board loader
      loader(KanbanLoader, () => [
        revalidate(({ actionId, defaultShouldRevalidate }) => {
          const isKanbanAction = actionId?.includes("kanban/actions");
          console.log("[Kanban] Revalidation", { actionId, isKanbanAction });
          return isKanbanAction ?? defaultShouldRevalidate;
        }),
      ]),

      path("/", KanbanIndexPage, { name: "index" }),
      path("/card/:cardId", KanbanCardPage, { name: "card" }, () => [
        loader(CardDetailLoader),
      ]),
    ]),
  ]),
]);
