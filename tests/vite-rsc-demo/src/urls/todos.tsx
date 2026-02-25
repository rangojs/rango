import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  TodosLayout,
  TodosIndexPage,
  TodoDetailPage,
  todosErrorBoundary,
} from "../pages/todos.js";
import { TodosLoader, TodoDetailLoader } from "../handlers/todos/loader.js";

export const todosPatterns = urls(
  ({ path, layout, loader, revalidate, errorBoundary }) => [
    // Passthrough layout for error boundary
    layout(<Outlet />, () => [
      errorBoundary(todosErrorBoundary),
      layout(<TodosLayout />, () => [
        // Todos loader with revalidation based on actions
        loader(TodosLoader, () => [
          revalidate(({ actionId, defaultShouldRevalidate }) => {
            const isTodosAction = actionId?.includes("todos/actions");
            return isTodosAction ?? defaultShouldRevalidate;
          }),
        ]),

        path("/", TodosIndexPage, { name: "index" }, () => [
          revalidate(() => false),
        ]),
        path("/:id", TodoDetailPage, { name: "detail" }, () => [
          loader(TodoDetailLoader),
          revalidate(() => false),
        ]),
      ]),
    ]),
  ],
);
