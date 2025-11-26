"use client";

import { useLoader } from "rsc-router/client";
import { TodosLoader } from "./loader.js";
import { DebugSegmentWrapper } from "../../components/DebugSegmentWrapper.js";
import { SegmentTimer } from "../../components/SegmentTimer.js";
import { AddTodoForm, TodoItem, TodoStats } from "./components.js";
import { useNavigation } from "rsc-router/browser";

export function TodosCount() {
  const data = useLoader(TodosLoader);
  return (
    <span
      style={{
        background: "rgba(255,255,255,0.2)",
        padding: "0.25rem 0.75rem",
        borderRadius: "12px",
        fontSize: "0.875rem",
      }}
    >
      {data.stats.pending} pending
    </span>
  );
}

export function TodosIndexContent({ serverValue }: { serverValue?: string }) {
  const data = useLoader(TodosLoader);
  const state = useNavigation((nav) => nav.state);
  const isLoading = state === "loading";
  return (
    <DebugSegmentWrapper type="route" name="Todos Index">
      <div style={{ maxWidth: "600px", margin: "0 auto" }}>
        <div
          style={{
            background: "#f8fafc",
            padding: "1.5rem",
            borderRadius: "12px",
            marginBottom: "1.5rem",
          }}
        >
          <h2 style={{ margin: "0 0 1rem 0", color: "#334155" }}>
            Server Actions Demo ({serverValue ?? "no server value"})
          </h2>
          <p style={{ color: "#64748b", margin: 0 }}>
            This page demonstrates RSC Router's server actions with optimistic
            updates. Add, edit, toggle, and delete todos - all powered by server
            actions with automatic revalidation.
          </p>
          {isLoading && <p>Loading...</p>}
        </div>

        <AddTodoForm />

        <TodoStats
          total={data.stats.total}
          completed={data.stats.completed}
          pending={data.stats.pending}
        />

        <div>
          {data.todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} />
          ))}
        </div>

        {data.todos.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "3rem",
              color: "#94a3b8",
            }}
          >
            <p style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
              No todos yet
            </p>
            <p>Add your first todo above!</p>
          </div>
        )}

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
          <p
            style={{
              fontSize: "0.875rem",
              color: "#666",
              margin: "0.5rem 0 0 0",
            }}
          >
            Check the Network tab for Server-Timing header to see detailed
            metrics.
          </p>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}
