import type { ErrorBoundaryFallbackProps } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { KanbanBoardContent } from "../handlers/kanban/KanbanBoard.js";
import { FullWidthLayout } from "../handlers/kanban/FullWidthLayout.js";
import { KanbanErrorBoundary } from "../handlers/kanban/KanbanErrorBoundary.js";

export function KanbanLayout() {
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
            <KanbanBoardContent />
            <Outlet name="@modal" />
            <Outlet />
          </div>
        </KanbanErrorBoundary>
      </FullWidthLayout>
    </DebugSegmentWrapper>
  );
}

export function KanbanIndexPage() {
  return <></>;
}

export function KanbanCardPage() {
  // Import dynamically to avoid bundling issues
  const { CardDetailContent } = require("../handlers/kanban/CardDetail.js");
  return <CardDetailContent />;
}

export function kanbanErrorBoundary({ error }: ErrorBoundaryFallbackProps) {
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
        <span style={{ fontSize: "1.5rem" }}>Warning</span>
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
