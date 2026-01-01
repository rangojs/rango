"use client";

import { useState, useActionState } from "react";
import { useLoader, useFetchLoader } from "rsc-router/client";
import {
  UsersLoader,
  StatsLoader,
  UserSearchLoader,
  RSCContentLoader,
  type UsersLoaderData,
  type RSCContentLoaderData,
} from "./loaders.js";
import {
  incrementPageViewsAction,
  resetCountersAction,
  addUserAction,
} from "./actions.js";

/**
 * UsersDisplay - Demonstrates useLoader for accessing SSR/navigation loader data
 *
 * The data is already loaded by the time this component renders.
 * useLoader() simply accesses the data from the loader context.
 */
export function UsersDisplay() {
  const data = useLoader<UsersLoaderData>(UsersLoader);

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        useLoader - SSR/Navigation Data
      </h3>
      <p style={descStyle}>
        Data loaded during SSR or navigation. Already available when component renders.
      </p>

      <div style={metaStyle}>
        <span>Source: {data.source}</span>
        <span>Call #{data.callCount}</span>
        <span>Loaded: {new Date(data.loadedAt).toLocaleTimeString()}</span>
      </div>

      <h4>Users ({data.users.length})</h4>
      <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
        {data.users.map((user) => (
          <li key={user.id}>
            <strong>{user.name}</strong> ({user.role}) - {user.email}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * StatsDisplay - Demonstrates useFetchLoader for on-demand client fetching
 *
 * Data is NOT loaded during SSR. The client fetches it when needed.
 * Perfect for data that should be loaded lazily or refreshed frequently.
 */
export function StatsDisplay() {
  const { data, isLoading, error, load } = useFetchLoader(StatsLoader);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const handleFetch = async () => {
    setActionResult(null);
    await load();
  };

  const handleIncrementPageViews = async () => {
    const result = await incrementPageViewsAction();
    setActionResult(`Page views incremented to ${result.newPageViews}`);
    // Refetch stats to see the updated value
    await load();
  };

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        useFetchLoader - On-Demand Client Fetching
      </h3>
      <p style={descStyle}>
        Data fetched via GET request when you click the button.
        Not loaded during SSR - perfect for lazy loading.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={handleFetch} disabled={isLoading} style={buttonStyle}>
          {isLoading ? "Loading..." : data ? "Refresh Stats" : "Load Stats"}
        </button>
        <button
          onClick={handleIncrementPageViews}
          disabled={isLoading}
          style={{ ...buttonStyle, background: "#10b981" }}
        >
          Increment Page Views
        </button>
      </div>

      {actionResult && (
        <div style={actionResultStyle}>{actionResult}</div>
      )}

      {error && (
        <div style={errorStyle}>Error: {error.message}</div>
      )}

      {data && (
        <>
          <div style={metaStyle}>
            <span>Source: {data.source}</span>
            <span>Call #{data.callCount}</span>
            <span>Loaded: {new Date(data.loadedAt).toLocaleTimeString()}</span>
          </div>

          <div style={statsGridStyle}>
            <StatCard label="Total Users" value={data.stats.totalUsers} />
            <StatCard label="Active Today" value={data.stats.activeToday} />
            <StatCard label="New This Week" value={data.stats.newThisWeek} />
            <StatCard label="Page Views" value={data.stats.pageViews} />
          </div>
        </>
      )}

      {!data && !isLoading && !error && (
        <div style={emptyStateStyle}>
          Click "Load Stats" to fetch data from the server
        </div>
      )}
    </div>
  );
}

/**
 * UserSearch - Demonstrates useFetchLoader with parameters
 *
 * Shows how to pass dynamic params from client to server loader.
 * The loader receives params via ctx.params.
 */
export function UserSearch() {
  const { data, isLoading, error, load } = useFetchLoader(UserSearchLoader);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");

  const handleSearch = async () => {
    await load({
      params: {
        query,
        role,
      },
    });
  };

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        useFetchLoader with Parameters
      </h3>
      <p style={descStyle}>
        Pass dynamic parameters from client to server loader.
        Parameters are available via ctx.params on the server.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search by name or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={inputStyle}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          style={selectStyle}
        >
          <option value="all">All Roles</option>
          <option value="admin">Admin</option>
          <option value="user">User</option>
          <option value="guest">Guest</option>
        </select>
        <button onClick={handleSearch} disabled={isLoading} style={buttonStyle}>
          {isLoading ? "Searching..." : "Search"}
        </button>
      </div>

      {error && (
        <div style={errorStyle}>Error: {error.message}</div>
      )}

      {data && (
        <>
          <div style={metaStyle}>
            <span>Query: "{data.query || "(empty)"}"</span>
            <span>Role: {data.roleFilter}</span>
            <span>Matches: {data.totalMatches}</span>
          </div>

          {data.results.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
              {data.results.map((user) => (
                <li key={user.id}>
                  <strong>{user.name}</strong> ({user.role}) - {user.email}
                </li>
              ))}
            </ul>
          ) : (
            <div style={emptyStateStyle}>No users match your search</div>
          )}
        </>
      )}

      {!data && !isLoading && !error && (
        <div style={emptyStateStyle}>
          Enter a search query and click "Search"
        </div>
      )}
    </div>
  );
}

/**
 * ResetCounters - Button to reset loader call counts
 */
export function ResetCounters() {
  const [message, setMessage] = useState<string | null>(null);

  const handleReset = async () => {
    const result = await resetCountersAction();
    setMessage(result.message);
    setTimeout(() => setMessage(null), 2000);
  };

  return (
    <div style={{ marginBottom: "1rem" }}>
      <button onClick={handleReset} style={{ ...buttonStyle, background: "#6b7280" }}>
        Reset Call Counters
      </button>
      {message && <span style={{ marginLeft: "0.5rem", color: "#10b981" }}>{message}</span>}
    </div>
  );
}

/**
 * AddUserForm - Demonstrates action + useFetchLoader refetch pattern
 *
 * Shows how to:
 * 1. Use a server action to modify data
 * 2. Use useFetchLoader to refetch updated data after the action
 *
 * This pattern is useful when you want to:
 * - Perform a mutation via server action
 * - Immediately reflect changes by refetching loader data
 */
export function AddUserForm() {
  const { data, isLoading, load } = useFetchLoader(UserSearchLoader);
  const [actionState, formAction, isPending] = useActionState(
    async (_prevState: unknown, formData: FormData) => {
      const result = await addUserAction(formData);
      if (result.success) {
        // After successful action, refetch to get updated user list
        await load({ params: { query: "", role: "all" } });
      }
      return result;
    },
    null
  );

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        Action + useFetchLoader Refetch Pattern
      </h3>
      <p style={descStyle}>
        Use a server action to modify data, then call <code>load()</code> to
        refetch updated data via the fetchable loader.
      </p>

      <form action={formAction} style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
          <input
            type="text"
            name="name"
            placeholder="Name"
            required
            style={inputStyle}
          />
          <input
            type="email"
            name="email"
            placeholder="Email"
            required
            style={inputStyle}
          />
          <select name="role" style={selectStyle}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
            <option value="guest">Guest</option>
          </select>
          <button
            type="submit"
            disabled={isPending}
            style={{ ...buttonStyle, background: "#10b981" }}
          >
            {isPending ? "Adding..." : "Add User"}
          </button>
        </div>
      </form>

      {actionState && "error" in actionState && (
        <div style={errorStyle}>{actionState.error}</div>
      )}

      {actionState && "success" in actionState && actionState.success && (
        <div style={actionResultStyle}>
          Added user: {actionState.user?.name}
        </div>
      )}

      {isLoading && <p>Refreshing user list...</p>}

      {data && (
        <div style={metaStyle}>
          <span>Users found: {data.totalMatches}</span>
        </div>
      )}

      <div
        style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#f0fdf4",
          borderRadius: "8px",
          fontSize: "0.875rem",
        }}
      >
        <strong>Pattern:</strong>
        <pre style={{ margin: "0.5rem 0 0 0", whiteSpace: "pre-wrap" }}>
{`const result = await addUserAction(formData);
if (result.success) {
  // Refetch to get updated data
  await load({ params: { query: "", role: "all" } });
}`}
        </pre>
      </div>
    </div>
  );
}

/**
 * FormActionSearch - Demonstrates load.formAction for progressive enhancement
 *
 * Shows how to use useFetchLoader with forms for:
 * - Progressive enhancement (works without JS)
 * - Automatic loading states
 * - Server-side execution
 */
export function FormActionSearch() {
  const { data, isLoading, error, load } = useFetchLoader(UserSearchLoader);

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        load.formAction - Progressive Enhancement
      </h3>
      <p style={descStyle}>
        Use <code>load.formAction</code> as a form action for progressive
        enhancement. Works without JavaScript, enhanced with loading states when JS is available.
      </p>

      <form action={load.formAction} style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            type="text"
            name="query"
            placeholder="Search users..."
            style={inputStyle}
          />
          <select name="role" style={selectStyle}>
            <option value="all">All Roles</option>
            <option value="admin">Admin</option>
            <option value="user">User</option>
            <option value="guest">Guest</option>
          </select>
          <button
            type="submit"
            disabled={isLoading}
            style={buttonStyle}
          >
            {isLoading ? "Searching..." : "Search"}
          </button>
        </div>
      </form>

      {error && (
        <div style={errorStyle}>Error: {error.message}</div>
      )}

      {data && (
        <>
          <div style={metaStyle}>
            <span>Query: "{data.query || "(empty)"}"</span>
            <span>Role: {data.roleFilter}</span>
            <span>Matches: {data.totalMatches}</span>
          </div>

          {data.results.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
              {data.results.map((user) => (
                <li key={user.id}>
                  <strong>{user.name}</strong> ({user.role}) - {user.email}
                </li>
              ))}
            </ul>
          ) : (
            <div style={emptyStateStyle}>No users match your search</div>
          )}
        </>
      )}

      <div
        style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#fef3c7",
          borderRadius: "8px",
          fontSize: "0.875rem",
        }}
      >
        <strong>Usage:</strong>
        <pre style={{ margin: "0.5rem 0 0 0", whiteSpace: "pre-wrap" }}>
{`const { load, isLoading } = useFetchLoader(UserSearchLoader);

<form action={load.formAction}>
  <input name="query" />
  <button type="submit" disabled={isLoading}>
    {isLoading ? "Searching..." : "Search"}
  </button>
</form>`}
        </pre>
      </div>
    </div>
  );
}

/**
 * RSCContentDisplay - Demonstrates useFetchLoader returning React Server Components
 *
 * Shows that loaders can return ReactNode, not just data.
 * The RSC protocol serializes React elements and streams them to the client.
 */
export function RSCContentDisplay() {
  const { data, isLoading, error, load } = useFetchLoader<RSCContentLoaderData>(RSCContentLoader);
  const [style, setStyle] = useState<"default" | "cards">("default");
  const [count, setCount] = useState("3");

  const handleLoad = async () => {
    await load({
      params: {
        style,
        count,
      },
    });
  };

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>
        useFetchLoader with RSC Content
      </h3>
      <p style={descStyle}>
        Loaders can return <code>ReactNode</code> instead of just data.
        The RSC protocol serializes React elements and streams them to the client.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value as "default" | "cards")}
          style={selectStyle}
        >
          <option value="default">List View</option>
          <option value="cards">Card View</option>
        </select>
        <select
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={selectStyle}
        >
          <option value="1">1 User</option>
          <option value="2">2 Users</option>
          <option value="3">3 Users</option>
          <option value="5">5 Users</option>
        </select>
        <button onClick={handleLoad} disabled={isLoading} style={buttonStyle}>
          {isLoading ? "Loading RSC..." : data ? "Refresh Content" : "Load RSC Content"}
        </button>
      </div>

      {error && (
        <div style={errorStyle}>Error: {error.message}</div>
      )}

      {data && (
        <>
          <div style={metaStyle}>
            <span>Style: {data.style}</span>
            <span>Count: {data.count}</span>
            <span>Rendered: {new Date(data.renderedAt).toLocaleTimeString()}</span>
          </div>

          <div
            style={{
              border: "2px dashed #c4b5fd",
              borderRadius: "8px",
              padding: "1rem",
              background: "#faf5ff",
            }}
          >
            <div style={{ fontSize: "0.75rem", color: "#6d28d9", marginBottom: "0.5rem" }}>
              ↓ Server-rendered React content ↓
            </div>
            {data.content}
          </div>
        </>
      )}

      {!data && !isLoading && !error && (
        <div style={emptyStateStyle}>
          Click "Load RSC Content" to fetch server-rendered React components
        </div>
      )}

      <div
        style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#f5f3ff",
          borderRadius: "8px",
          fontSize: "0.875rem",
        }}
      >
        <strong>How it works:</strong>
        <pre style={{ margin: "0.5rem 0 0 0", whiteSpace: "pre-wrap" }}>
{`// Server loader returns ReactNode
export const RSCContentLoader = createLoader(
  "loaders-demo-rsc-content",
  async (ctx) => {
    "use server";
    const style = ctx.params.style;

    // Return server-rendered JSX
    return {
      content: <UserCards users={users} />,
      style,
    };
  },
  true // fetchable
);

// Client renders the content directly
const { data } = useFetchLoader(RSCContentLoader);
return <div>{data.content}</div>;`}
        </pre>
      </div>
    </div>
  );
}

// Helper component for stats display
function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={statCardStyle}>
      <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{value}</div>
      <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>{label}</div>
    </div>
  );
}

// Styles
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1.5rem",
  marginBottom: "1.5rem",
  background: "white",
};

const headingStyle: React.CSSProperties = {
  margin: "0 0 0.5rem 0",
  color: "#1f2937",
  fontSize: "1.25rem",
};

const descStyle: React.CSSProperties = {
  margin: "0 0 1rem 0",
  color: "#6b7280",
  fontSize: "0.875rem",
};

const metaStyle: React.CSSProperties = {
  display: "flex",
  gap: "1rem",
  fontSize: "0.75rem",
  color: "#9ca3af",
  marginBottom: "1rem",
  flexWrap: "wrap",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.875rem",
};

const inputStyle: React.CSSProperties = {
  padding: "0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.875rem",
  minWidth: "200px",
};

const selectStyle: React.CSSProperties = {
  padding: "0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.875rem",
};

const errorStyle: React.CSSProperties = {
  color: "#dc2626",
  background: "#fef2f2",
  padding: "0.75rem",
  borderRadius: "6px",
  marginBottom: "1rem",
};

const actionResultStyle: React.CSSProperties = {
  color: "#059669",
  background: "#ecfdf5",
  padding: "0.75rem",
  borderRadius: "6px",
  marginBottom: "1rem",
};

const emptyStateStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontStyle: "italic",
  padding: "1rem",
  textAlign: "center",
  background: "#f9fafb",
  borderRadius: "6px",
};

const statsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: "1rem",
};

const statCardStyle: React.CSSProperties = {
  background: "#f9fafb",
  padding: "1rem",
  borderRadius: "6px",
  textAlign: "center",
};
