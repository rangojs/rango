import { map } from "rsc-router/server";
import { Outlet } from "rsc-router/client";
import type { todosRoutes } from "../routes.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { TodosLoader, TodoDetailLoader } from "./todos/loader.js";
import { TodosCount, TodosIndexContent } from "./todos/TodosList.js";
import { TodoDetailContent } from "./todos/TodoDetail.js";
import { r } from "@vitejs/plugin-rsc/browser-C8KlM-b7";

// Layout component for Todos section (server component)
function TodosLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Todos">
      <div>
        <header
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            color: "white",
            padding: "1.5rem",
            marginBottom: "2rem",
            borderRadius: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h1 style={{ margin: 0, color: "white" }}>Todos</h1>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <a
                href="/todos"
                style={{ color: "white", textDecoration: "none" }}
              >
                All Todos
              </a>
              <TodosCount />
            </div>
          </div>
        </header>
        <DebugSegmentWrapper type="outlet" name="Todos Outlet">
          <Outlet />
        </DebugSegmentWrapper>
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Todos handler - demonstrates loaders, actions, and revalidation
 */
export default map<typeof todosRoutes>(
  ({ route, layout, loader, revalidate }) => [
    // Root layout with todos loader
    layout(<TodosLayout />, () => [
      // Global todos loader
      loader(TodosLoader, () => [
        // Revalidate on any todo action
        // Note: actionId format is like "/src/handlers/todos/actions.ts#addTodo"
        revalidate(({ actionId, method, defaultShouldRevalidate }) => {
          console.log("loader revalidation called", { actionId, method });

          // On POST (action), revalidate if it's a todos action
          if (method === "POST" && actionId) {
            const isTodosAction = actionId.includes("todos/actions");
            return isTodosAction;
          }

          // On GET (navigation), use default behavior
          return { defaultShouldRevalidate };
        }),
      ]),

      // Index route - list all todos
      route(
        "index",
        () => (
          <TodosIndexContent
            serverValue={Math.random().toString(36).substring(2, 7)}
          />
        ),
        () => [revalidate(() => false)]
      ),

      // Detail route - view single todo
      route(
        "detail",
        () => <TodoDetailContent />,
        () => [loader(TodoDetailLoader), revalidate(() => false)]
      ),
    ]),
  ]
);
