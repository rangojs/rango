import type { HandlerContext, Revalidate, GenericParams, RevalidateParams } from "@rangojs/router";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

export function AdminIndexPage() {
  return (
    <DebugSegmentWrapper type="route" name="Admin Index">
      <div>
        <h2>Admin Dashboard</h2>
        <p className="segment-id">Segment: Admin Index</p>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          Demonstrates soft/hard revalidation pattern
        </p>

        <div style={{
          background: "#e3f2fd",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
        }}>
          <h3 style={{ marginTop: 0 }}>Revalidation Behavior:</h3>
          <ul style={{ lineHeight: 1.8 }}>
            <li>
              <strong>Global:</strong> Soft decision suggests <code>revalidate=true</code>
            </li>
            <li>
              <strong>Settings:</strong> Hard decision <code>false</code> (never revalidates)
            </li>
            <li>
              <strong>User Detail:</strong> Hard decision based on ID change
            </li>
            <li>
              <strong>Users List:</strong> No override - uses global soft (revalidates)
            </li>
          </ul>
        </div>

        <nav style={{ marginTop: "2rem" }}>
          <h4>Navigate to test:</h4>
          <ul>
            <li><a href="/admin/users">Users List</a> (uses global soft - revalidates)</li>
            <li><a href="/admin/users/123">User 123</a> (hard: only if ID changes)</li>
            <li><a href="/admin/users/456">User 456</a> (hard: ID changed - revalidates)</li>
            <li><a href="/admin/settings">Settings</a> (hard: never revalidates)</li>
          </ul>
        </nav>
      </div>
    </DebugSegmentWrapper>
  );
}

export function AdminUsersPage() {
  return (
    <DebugSegmentWrapper type="route" name="Users List">
      <div>
        <h2>Users List</h2>
        <p className="segment-id">Segment: Users List</p>
        <p>Server render time: {new Date().toISOString()}</p>

        <div style={{
          background: "#fff3cd",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
          border: "2px solid #856404",
        }}>
          <p style={{ margin: 0, color: "#856404" }}>
            <strong>Revalidation:</strong> Uses global SOFT decision - always revalidates
          </p>
        </div>

        <ul style={{ marginTop: "1rem" }}>
          <li><a href="/admin/users/123">User 123</a></li>
          <li><a href="/admin/users/456">User 456</a></li>
          <li><a href="/admin/users/789">User 789</a></li>
        </ul>
        <p><a href="/admin">Back to Admin</a></p>
      </div>
    </DebugSegmentWrapper>
  );
}

export function AdminUserPage(ctx: HandlerContext<{ id: string }>) {
  return (
    <DebugSegmentWrapper type="route" name="User Detail">
      <div>
        <h2>User {ctx.params.id}</h2>
        <p className="segment-id">Segment: User Detail (ID: {ctx.params.id})</p>
        <p>Server render time: {new Date().toISOString()}</p>

        <div style={{
          background: "#fff3cd",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
          border: "2px solid #856404",
        }}>
          <p style={{ margin: 0, color: "#856404" }}>
            <strong>Revalidation:</strong> HARD decision - only revalidates if ID changes
          </p>
        </div>

        <div style={{
          background: "#f8f9fa",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
        }}>
          <h3 style={{ marginTop: 0 }}>Test Revalidation:</h3>
          <ul>
            <li>
              <a href={`/admin/users/${ctx.params.id}?tab=1`}>
                Add ?tab=1
              </a> (ID unchanged - no revalidation)
            </li>
            <li>
              <a href="/admin/users/456">
                Navigate to User 456
              </a> (ID changed - revalidates)
            </li>
          </ul>
        </div>

        <p><a href="/admin/users">Back to Users</a></p>
      </div>
    </DebugSegmentWrapper>
  );
}

export function AdminSettingsPage() {
  return (
    <DebugSegmentWrapper type="route" name="Admin Settings">
      <div>
        <h2>Admin Settings</h2>
        <p className="segment-id">Segment: Admin Settings</p>
        <p>Server render time: {new Date().toISOString()}</p>

        <div style={{
          background: "#d1ecf1",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
          border: "2px solid #0c5460",
        }}>
          <p style={{ margin: 0, color: "#0c5460" }}>
            <strong>Revalidation:</strong> HARD decision <code>false</code> - NEVER revalidates (static)
          </p>
        </div>

        <div style={{
          background: "#f8f9fa",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
        }}>
          <h3 style={{ marginTop: 0 }}>Test Static Behavior:</h3>
          <p>Navigate away and back - notice this segment never re-renders!</p>
          <ul>
            <li><a href="/admin">Admin Home</a></li>
            <li><a href="/admin/settings?tab=1">Settings?tab=1</a> (no revalidation)</li>
          </ul>
          <p style={{ fontSize: "0.9rem", color: "#666" }}>
            The timestamp above will NOT change even when navigating between these links.
          </p>
        </div>

        <p><a href="/admin">Back to Admin</a></p>
      </div>
    </DebugSegmentWrapper>
  );
}

// Revalidation functions
export const globalRevalidation: Revalidate<GenericParams, RSCRouter.Env> = () => {
  console.log("[Admin] Global: SOFT decision - suggest revalidate=true, continue...");
  return { defaultShouldRevalidate: true };
};

export const settingsRevalidation: Revalidate<GenericParams, RSCRouter.Env> = () => {
  console.log("[Admin] Settings: HARD decision - never revalidate");
  return false;
};

export const userRevalidation = (params: RevalidateParams<{ id: string }>) => {
  const changed = params.currentParams.id !== params.nextParams.id;
  console.log(`[Admin] User detail: HARD decision - ID changed=${changed}`);
  return changed;
};
