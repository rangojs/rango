"use client";

import { useLoader } from "rsc-router/client";
import { KanbanLoader } from "./loader.js";
import { KanbanBoard } from "./components.js";
import { DebugSegmentWrapper } from "../../components/DebugSegmentWrapper.js";

export function KanbanBoardContent() {
  const board = useLoader(KanbanLoader);

  return (
    <DebugSegmentWrapper type="route" name="Kanban Index">
      <div
        data-testid="kanban-board"
        style={{
          background: "#e2e8f0",
          borderRadius: "0 0 8px 8px",
          minHeight: "calc(100vh - 250px)",
        }}
      >
        <KanbanBoard board={board} />
      </div>
    </DebugSegmentWrapper>
  );
}
