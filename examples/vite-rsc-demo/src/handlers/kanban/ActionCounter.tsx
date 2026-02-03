"use client";

import { useLoader, Outlet } from "@rangojs/router/client";
import { ActionCounterLoader } from "./loader.js";

export function ActionCounterDisplay() {
  const { data } = useLoader(ActionCounterLoader);
  const counts = data.counts;
  const total = data.total;

  return (
    <div
      data-testid="action-counter"
      style={{
        padding: "0.5rem 1rem",
        background: "#f0fdf4",
        borderLeft: "4px solid #22c55e",
        fontSize: "0.8rem",
        color: "#166534",
        display: "flex",
        gap: "1rem",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <strong>Action Counts (loader revalidation test):</strong>
      {Object.keys(counts).length === 0 ? (
        <span style={{ color: "#6b7280", fontStyle: "italic" }}>
          No actions yet - perform actions to see counts
        </span>
      ) : (
        Object.entries(counts).map(([action, count]) => (
          <span
            key={action}
            style={{
              background: "#dcfce7",
              padding: "0.25rem 0.5rem",
              borderRadius: "4px",
            }}
          >
            {action}: {count}
          </span>
        ))
      )}
      <span style={{ marginLeft: "auto", fontWeight: 600 }} data-testid="action-counter-total">
        Total unique actions: {total}
      </span>
    </div>
  );
}

// Layout wrapper that includes the counter display and outlet
export function ActionCounterLayout() {
  return (
    <>
      <ActionCounterDisplay />
      <Outlet />
    </>
  );
}
