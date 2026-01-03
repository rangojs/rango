"use client";

import { useLoader } from "rsc-router/client";
import { TodoDetailLoader } from "./loader.js";
import { DebugSegmentWrapper } from "../../components/DebugSegmentWrapper.js";
import { SegmentTimer } from "../../components/SegmentTimer.js";

export function TodoDetailContent() {
  const { data: todo } = useLoader(TodoDetailLoader);

  return (
    <DebugSegmentWrapper type="route" name="Todo Detail">
      <div style={{ maxWidth: "600px", margin: "0 auto" }}>
        <a
          href="/todos"
          style={{
            display: "inline-block",
            marginBottom: "1rem",
            color: "#667eea",
            textDecoration: "none",
          }}
        >
          &larr; Back to all todos
        </a>

        <div
          style={{
            background: "white",
            padding: "2rem",
            borderRadius: "12px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          <h2 style={{ margin: "0 0 1rem 0" }}>{todo.title}</h2>

          <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
            <span
              style={{
                padding: "0.25rem 0.75rem",
                borderRadius: "12px",
                fontSize: "0.875rem",
                background: todo.completed ? "#dcfce7" : "#fef3c7",
                color: todo.completed ? "#166534" : "#92400e",
              }}
            >
              {todo.completed ? "Completed" : "Pending"}
            </span>
          </div>

          <div style={{ color: "#64748b", fontSize: "0.875rem" }}>
            <p style={{ margin: "0.25rem 0" }}>
              Created: {todo.createdAt.toLocaleDateString()}
            </p>
            <p style={{ margin: "0.25rem 0" }}>
              Updated: {todo.updatedAt.toLocaleDateString()}
            </p>
          </div>
        </div>

        <div
          style={{
            marginTop: "2rem",
            padding: "1rem",
            background: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0" }}>Performance</h4>
          <SegmentTimer />
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}
