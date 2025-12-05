import { map } from "rsc-router/server";
import { Outlet } from "rsc-router/client";
import type { kanbanRoutes } from "../routes.js";
import type { ErrorBoundaryFallbackProps } from "rsc-router";
import { RootLayout } from "../layouts/RootLayout.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { KanbanLoader, CardDetailLoader } from "./kanban/loader.js";
import { KanbanBoardContent } from "./kanban/KanbanBoard.js";
import { CardDetailContent, CardDetailSkeleton } from "./kanban/CardDetail.js";
import { FullWidthLayout } from "./kanban/FullWidthLayout.js";
import { KanbanErrorBoundary } from "./kanban/KanbanErrorBoundary.js";

// Layout component for Kanban section
function KanbanLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Kanban">
      <FullWidthLayout>
        <KanbanErrorBoundary>
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
            {/* Error testing banner */}
            <div
              style={{
                background: "#fef3c7",
                borderLeft: "4px solid #f59e0b",
                padding: "0.75rem 1rem",
                fontSize: "0.8rem",
                color: "#92400e",
              }}
            >
              <strong>Error Testing:</strong> Add/move cards to "Error Test"
              column or name a card "error" for server errors. Add "error" in a
              card's description for client errors.
            </div>
            {/* Board is always visible */}
            <KanbanBoardContent />
            {/* Intercept modal slot - for soft navigation to card route */}
            <Outlet name="@modal" />
            {/* Route content - for hard navigation (direct URL) */}
            <Outlet />
          </div>
        </KanbanErrorBoundary>
      </FullWidthLayout>
    </DebugSegmentWrapper>
  );
}

// Modal wrapper layout for intercepted card route
// Uses Outlet to receive loader data context
function CardModalWrapper() {
  return (
    <DebugSegmentWrapper type="parallel" name="CardModal (@modal)">
      <Outlet />
    </DebugSegmentWrapper>
  );
}

// Custom error fallback for Kanban board
function KanbanErrorFallback({ error }: ErrorBoundaryFallbackProps) {
  return (
    <div
      style={{
        padding: "2rem",
        background: "linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)",
        borderRadius: "8px",
        border: "1px solid #fecaca",
        margin: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <span style={{ fontSize: "1.5rem" }}>⚠️</span>
        <h2 style={{ margin: 0, color: "#991b1b", fontSize: "1.25rem" }}>
          Board Error
        </h2>
      </div>
      <p style={{ color: "#7f1d1d", marginBottom: "1rem" }}>
        Something went wrong loading the Kanban board.
      </p>
      <div
        style={{
          background: "white",
          padding: "1rem",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      >
        <p
          style={{
            margin: 0,
            fontFamily: "monospace",
            fontSize: "0.875rem",
            color: "#dc2626",
          }}
        >
          {error.name}: {error.message}
        </p>
      </div>
      <a
        href="/kanban"
        style={{
          display: "inline-block",
          padding: "0.5rem 1rem",
          background: "#0ea5e9",
          color: "white",
          textDecoration: "none",
          borderRadius: "4px",
        }}
      >
        Reload Board
      </a>
    </div>
  );
}

/**
 * Kanban handler - demonstrates optimistic updates with drag-and-drop
 * Uses intercepting routes to show card detail as modal during soft navigation
 */
export default map<typeof kanbanRoutes>(
  ({
    route,
    layout,
    loader,
    revalidate,
    intercept,
    loading,
    errorBoundary,
  }) => [
    layout(<RootLayout />),

    // Kanban section layout with loader and intercept
    layout(<KanbanLayout />, () => [
      // Server-side error boundary for this section
      errorBoundary(KanbanErrorFallback),

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
      // Uses layout(<CardModalWrapper />) to properly chain loader data context via Outlet
      intercept("@modal", "card", <CardDetailContent />, () => [
        layout(<CardModalWrapper />),
        loading(<CardDetailSkeleton />),
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
      () => [
        loader(CardDetailLoader, () => [
          // Revalidate on any kanban action
          revalidate(({ actionId, method, defaultShouldRevalidate }) => {
            if (method === "POST" && actionId) {
              const isKanbanAction = actionId.toLowerCase().includes("kanban");
              return isKanbanAction;
            }
            return { defaultShouldRevalidate };
          }),
        ]),
        revalidate(() => false),
      ]
    ),
  ]
);
