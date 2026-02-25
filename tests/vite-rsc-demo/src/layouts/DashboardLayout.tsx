import { Outlet, ParallelOutlet } from "@rangojs/router/client";

export function DashboardLayout() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr 200px",
        gap: "1rem",
      }}
    >
      {/* Left sidebar - using ParallelOutlet for @sidebar slot */}
      <div
        style={{ background: "#f5f5f5", padding: "1rem", borderRadius: "8px" }}
      >
        <h3>Dashboard Layout</h3>
        <p className="segment-id">Segment: DashboardLayout</p>
        <ParallelOutlet name="@sidebar" />
      </div>
      <div>
        {/* Main content */}
        <Outlet />
        {/* Footer parallel slot - renders after main content */}
        <ParallelOutlet name="@footer" />
      </div>
      <div
        style={{ background: "#f0f0f0", padding: "1rem", borderRadius: "8px" }}
      >
        <p style={{ fontSize: "0.85rem", color: "#666" }}>Right sidebar area</p>
      </div>
    </div>
  );
}
