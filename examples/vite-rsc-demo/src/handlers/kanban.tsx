import { map } from "rsc-router/server";
import { Outlet } from "rsc-router/client";
import type { kanbanRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { KanbanLoader, CardDetailLoader } from "./kanban/loader.js";
import { KanbanBoardContent } from "./kanban/KanbanBoard.js";
import { CardDetailContent } from "./kanban/CardDetail.js";
import { FullWidthLayout } from "./kanban/FullWidthLayout.js";

// Layout component for Kanban section
function KanbanLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Kanban">
      <FullWidthLayout>
        <div>
          <header
            style={{
              background: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)",
              color: "white",
              padding: "1rem 1.5rem",
              marginBottom: "0",
              borderRadius: "8px 8px 0 0",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h1 style={{ margin: 0, color: "white", fontSize: "1.5rem" }}>
                Kanban Board
              </h1>
              <span
                style={{
                  background: "rgba(255,255,255,0.2)",
                  padding: "0.25rem 0.75rem",
                  borderRadius: "12px",
                  fontSize: "0.875rem",
                }}
              >
                Drag cards to reorder
              </span>
            </div>
          </header>
          {/* Board is always visible */}
          <KanbanBoardContent />
          {/* Intercept modal slot - for soft navigation to card route */}
          <Outlet name="@modal" />
          {/* Route content - for hard navigation (direct URL) */}
          <Outlet />
        </div>
      </FullWidthLayout>
    </DebugSegmentWrapper>
  );
}

// Modal wrapper for intercepted card route
// Uses type="parallel" since intercepts render in slots like parallels
function CardModal() {
  return (
    <DebugSegmentWrapper type="parallel" name="CardModal (@modal)">
      <CardDetailContent />
    </DebugSegmentWrapper>
  );
}

/**
 * Kanban handler - demonstrates optimistic updates with drag-and-drop
 * Uses intercepting routes to show card detail as modal during soft navigation
 */
export default map<typeof kanbanRoutes>(
  ({ route, layout, loader, revalidate, intercept }) => [
    layout(<RootLayout />),

    // Kanban section layout with loader and intercept
    layout(<KanbanLayout />, () => [
      // Board loader
      loader(KanbanLoader, () => [
        // Revalidate on any kanban action
        revalidate(({ actionId, method, defaultShouldRevalidate }) => {
          if (method === "POST" && actionId) {
            const isKanbanAction = actionId.toLowerCase().includes("kanban");
            return isKanbanAction;
          }
          return { defaultShouldRevalidate };
        }),
      ]),

      // Intercept card route during soft navigation
      // Renders in @modal slot instead of default Outlet
      intercept("@modal", "card", <CardModal />, () => [
        loader(CardDetailLoader),
        revalidate(() => false),
      ]),
    ]),

    // Index route - board is in layout, nothing extra needed here
    route("index", () => <></>),

    // Card detail route - full page for hard navigation (direct URL)
    route(
      "card",
      () => <CardDetailContent />,
      () => [loader(CardDetailLoader), revalidate(() => false)]
    ),
  ]
);
