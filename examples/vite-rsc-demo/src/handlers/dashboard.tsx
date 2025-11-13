import { map, route, layout, parallel, revalidate } from "rsc-router";
import type { dashboardRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { DashboardLayout } from "../layouts/DashboardLayout.js";

/**
 * Dashboard handlers with parallel routes
 * Demonstrates both shorthand and explicit route() syntax
 * Shows context-based revalidation
 */
export default map<typeof dashboardRoutes>({
  // Global layouts - apply to all dashboard routes
  [layout("*", "root")]: <RootLayout />,
  [layout("*", "dashboard")]: <DashboardLayout />,

  // Revalidation - demonstrates context usage
  // In real app, could check if user permissions changed, data expired, etc.
  [revalidate("*", "context")]: ({ context, currentUrl, nextUrl }) => {
    console.log("[Dashboard] Context-based revalidation check");
    // Example: Could check context.user?.updatedAt or other app state
    // For demo, just use URL change as proxy for "context changed"
    return currentUrl.search !== nextUrl.search; // Revalidate if query params changed
  },

  // Parallel routes for index
  [parallel("index", "slots")]: {
    "@footer": () => (
      <div
        style={{
          background: "#e8f4f8",
          padding: "1rem",
          marginTop: "2rem",
          borderRadius: "8px",
        }}
      >
        <p className="segment-id">Segment: @footer (index parallel)</p>
        <p style={{ fontSize: "0.85rem" }}>
          This footer appears on dashboard index
        </p>
      </div>
    ),
    "@sidebar": () => (
      <div
        style={{ background: "#fff3cd", padding: "1rem", borderRadius: "8px" }}
      >
        <p className="segment-id">Segment: @sidebar (index)</p>
        <h4>Dashboard Sidebar</h4>
        <ul>
          <li>Overview</li>
          <li>Analytics</li>
          <li>
            <a href="/dashboard/settings">Settings</a>
          </li>
        </ul>
      </div>
    ),
  },

  // Parallel routes for settings
  [parallel("settings", "slots")]: {
    "@footer": () => (
      <div
        style={{
          background: "#e8f4f8",
          padding: "1rem",
          marginTop: "2rem",
          borderRadius: "8px",
        }}
      >
        <p className="segment-id">Segment: @footer (settings parallel)</p>
        <p style={{ fontSize: "0.85rem" }}>
          This footer appears on dashboard settings
        </p>
      </div>
    ),
    "@sidebar": () => (
      <div
        style={{ background: "#fff3cd", padding: "1rem", borderRadius: "8px" }}
      >
        <p className="segment-id">Segment: @sidebar (settings)</p>
        <h4>Settings Sidebar</h4>
        <ul>
          <li>Profile</li>
          <li>Preferences</li>
          <li>
            <a href="/dashboard">← Back to Dashboard</a>
          </li>
        </ul>
      </div>
    ),
  },

  // Route: index (using explicit route() helper)
  [route("index")]: () => (
    <div
      style={{
        background: "#f0f9ff",
        padding: "2rem",
        borderRadius: "8px",
        border: "2px solid #0066cc",
      }}
    >
      <h1>📊 Dashboard Home</h1>
      <p className="segment-id">Segment: Dashboard Index Route</p>
      <div
        style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "white",
          borderRadius: "4px",
        }}
      >
        <h3>Overview</h3>
        <p>Welcome to your dashboard! Here are your stats:</p>
        <ul>
          <li>📈 Total Users: 1,234</li>
          <li>💰 Revenue: $56,789</li>
          <li>🎯 Conversion Rate: 3.2%</li>
        </ul>
        <p style={{ marginTop: "1rem" }}>
          <a
            href="/dashboard/settings"
            style={{ color: "#0066cc", textDecoration: "underline" }}
          >
            Go to Settings →
          </a>
        </p>
      </div>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#666" }}>
        <strong>Active parallel routes:</strong> @sidebar, @footer
      </p>
    </div>
  ),

  // Route: settings (using shorthand syntax)
  settings: () => (
    <div
      style={{
        background: "#fff7ed",
        padding: "2rem",
        borderRadius: "8px",
        border: "2px solid #f59e0b",
      }}
    >
      <h1>⚙️ Settings</h1>
      <p className="segment-id">Segment: Settings Route</p>
      <div
        style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "white",
          borderRadius: "4px",
        }}
      >
        <h3>Configuration</h3>
        <form style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <label>
            <strong>Username:</strong>
            <input
              type="text"
              value="john.doe"
              readOnly
              style={{ marginLeft: "1rem", padding: "0.5rem" }}
            />
          </label>
          <label>
            <strong>Email:</strong>
            <input
              type="email"
              value="john@example.com"
              readOnly
              style={{ marginLeft: "1rem", padding: "0.5rem" }}
            />
          </label>
          <label>
            <strong>Theme:</strong>
            <select style={{ marginLeft: "1rem", padding: "0.5rem" }}>
              <option>Light</option>
              <option>Dark</option>
            </select>
          </label>
        </form>
        <p style={{ marginTop: "1rem" }}>
          <a
            href="/dashboard"
            style={{ color: "#f59e0b", textDecoration: "underline" }}
          >
            ← Back to Dashboard
          </a>
        </p>
      </div>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#666" }}>
        <strong>Active parallel routes:</strong> @sidebar, @footer
      </p>
    </div>
  ),
});
