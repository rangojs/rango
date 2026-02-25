// Re-export the DashboardLayout from layouts
export { DashboardLayout } from "../layouts/DashboardLayout.js";

export function DashboardIndexPage() {
  return (
    <div
      style={{ background: "#f0f9ff", padding: "2rem", borderRadius: "8px" }}
    >
      <p className="segment-id">Segment: Dashboard Index</p>
      <h1>Dashboard Home</h1>
      <p>Welcome to your dashboard</p>
    </div>
  );
}

export function DashboardSettingsPage() {
  return (
    <div
      style={{ background: "#f0f9ff", padding: "2rem", borderRadius: "8px" }}
    >
      <p className="segment-id">Segment: Dashboard Settings</p>
      <h1>Dashboard Settings</h1>
      <p>Configure your dashboard</p>
      <p style={{ marginTop: "1rem" }}>
        <a href="/dashboard">Back to Dashboard</a>
      </p>
    </div>
  );
}

export function DashboardSidebar() {
  return (
    <div
      style={{ background: "#fff3cd", padding: "1rem", borderRadius: "8px" }}
    >
      <p className="segment-id">Segment: @sidebar</p>
      <h4>Dashboard Sidebar</h4>
      <ul>
        <li>Overview</li>
        <li>Analytics</li>
        <li>
          <a href="/dashboard/settings">Settings</a>
        </li>
      </ul>
    </div>
  );
}

export function DashboardFooter() {
  return (
    <div
      style={{
        background: "#e8f4f8",
        padding: "1rem",
        marginTop: "2rem",
        borderRadius: "8px",
      }}
    >
      <p className="segment-id">Segment: @footer</p>
      <p style={{ fontSize: "0.85rem" }}>Dashboard footer</p>
    </div>
  );
}
