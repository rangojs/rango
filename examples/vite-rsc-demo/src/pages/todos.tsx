import type { ErrorBoundaryFallbackProps } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { TodosCount, TodosIndexContent } from "../handlers/todos/TodosList.js";
import { TodoDetailContent } from "../handlers/todos/TodoDetail.js";

export function TodosLayout() {
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

export function TodosIndexPage() {
  return (
    <TodosIndexContent
      serverValue={Math.random().toString(36).substring(2, 7)}
    />
  );
}

export function TodoDetailPage() {
  return <TodoDetailContent />;
}

export function todosErrorBoundary({ error }: ErrorBoundaryFallbackProps) {
  return (
    <div
      style={{
        color: "#dc2626",
        padding: "1.5rem",
        border: "2px solid #dc2626",
        borderRadius: "8px",
        margin: "1rem 0",
        background: "#fef2f2",
      }}
    >
      <h3 style={{ margin: "0 0 0.5rem 0", color: "#991b1b" }}>
        Something went wrong in Todos section
      </h3>
      <p style={{ margin: "0 0 1rem 0" }}>{error.message}</p>
      <a
        href="/todos"
        style={{
          display: "inline-block",
          padding: "0.5rem 1rem",
          background: "#dc2626",
          color: "white",
          borderRadius: "6px",
          textDecoration: "none",
        }}
      >
        Go back to Todos
      </a>
    </div>
  );
}
