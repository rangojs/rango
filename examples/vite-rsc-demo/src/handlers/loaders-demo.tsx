import { map } from "@ivogt/rsc-router/server";
import { Outlet, Link } from "@ivogt/rsc-router/client";
import type { loadersRoutes } from "../routes.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { UsersLoader } from "./loaders-demo/loaders.js";
import {
  UsersDisplay,
  StatsDisplay,
  UserSearch,
  ResetCounters,
  AddUserForm,
  FormActionSearch,
  RSCContentDisplay,
  NotesManager,
  FileUploader,
  ChatStream,
} from "./loaders-demo/components.js";

/**
 * Loaders Demo Layout
 * Provides navigation and context for the loaders demo
 */
function LoadersDemoLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Loaders Demo">
      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "2rem" }}>
        <header
          style={{
            background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
            color: "white",
            padding: "2rem",
            borderRadius: "12px",
            marginBottom: "2rem",
          }}
        >
          <h1 style={{ margin: "0 0 0.5rem 0", color: "white" }}>
            Loaders API Demo
          </h1>
          <p style={{ margin: 0, opacity: 0.9 }}>
            Demonstrates useLoader and useFetchLoader APIs for data loading
          </p>
        </header>

        <nav
          style={{
            display: "flex",
            gap: "1rem",
            marginBottom: "2rem",
            padding: "1rem",
            background: "#f9fafb",
            borderRadius: "8px",
          }}
        >
          <Link
            to="/loaders"
            style={{
              padding: "0.5rem 1rem",
              background: "#3b82f6",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Index (useLoader)
          </Link>
          <Link
            to="/loaders/stats"
            style={{
              padding: "0.5rem 1rem",
              background: "#8b5cf6",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Stats (useFetchLoader)
          </Link>
        </nav>

        <Outlet />
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Index page - demonstrates useLoader
 * Shows how to access data loaded during SSR/navigation
 */
function LoadersIndexPage() {
  return (
    <DebugSegmentWrapper type="route" name="Loaders Index">
      <div>
        <h2>useLoader - SSR/Navigation Data Loading</h2>
        <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
          The <code>useLoader</code> hook accesses data that was loaded during
          SSR or client navigation. The data is already available when the
          component renders - no loading states needed.
        </p>

        <div
          style={{
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#0369a1" }}>
            How it works:
          </h4>
          <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "#0369a1" }}>
            <li>Loader runs on server during SSR or navigation</li>
            <li>Data is streamed as part of the RSC payload</li>
            <li>
              <code>useLoader()</code> accesses data from loader context
            </li>
            <li>No client-side fetch - data is already there</li>
          </ol>
        </div>

        <ResetCounters />
        <UsersDisplay />

        <div
          style={{
            marginTop: "2rem",
            padding: "1rem",
            background: "#fef3c7",
            borderRadius: "8px",
          }}
        >
          <strong>Try it:</strong> Navigate to{" "}
          <Link to="/loaders/stats">/loaders/stats</Link> and back. Notice how
          the call count increments - the loader runs on each navigation.
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Stats page - demonstrates useFetchLoader
 * Shows how to fetch data on-demand from client components
 */
function LoadersStatsPage() {
  return (
    <DebugSegmentWrapper type="route" name="Loaders Stats">
      <div>
        <h2>useFetchLoader - On-Demand Client Fetching</h2>
        <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
          The <code>useFetchLoader</code> hook fetches loader data on-demand via
          GET requests. Perfect for data that should load lazily or refresh
          frequently.
        </p>

        <div
          style={{
            background: "#f5f3ff",
            border: "1px solid #c4b5fd",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#6d28d9" }}>
            How it works:
          </h4>
          <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "#6d28d9" }}>
            <li>
              Loader marked as <code>fetchable: true</code> (3rd arg)
            </li>
            <li>
              Client calls <code>load()</code> to trigger GET request
            </li>
            <li>Server looks up loader by hashed ID and executes it</li>
            <li>RSC stream response parsed and state updated</li>
          </ol>
        </div>

        <ResetCounters />
        <UsersDisplay />
        <StatsDisplay />
        <ChatStream />
        <UserSearch />
        <FormActionSearch />
        <NotesManager />
        <FileUploader />
        <RSCContentDisplay />
        <AddUserForm />

        <div
          style={{
            marginTop: "2rem",
            padding: "1rem",
            background: "#fef3c7",
            borderRadius: "8px",
          }}
        >
          <strong>Try it:</strong> Click "Load Stats" multiple times. Each click
          makes a new GET request to the server. The call count shows how many
          times the loader has been executed.
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Loaders Demo handler - demonstrates loader APIs
 */
export default map<typeof loadersRoutes>(
  ({ route, layout, loader, revalidate }) => [
    // Layout with users loader (for useLoader demo)
    layout(<LoadersDemoLayout />, () => [
      // Global loader for the demo - provides users data
      loader(UsersLoader, () => [
        revalidate(({ actionId, stale, defaultShouldRevalidate }) => {
          // Check if this is a user-related action by matching the source file path
          // actionId format is "src/handlers/loaders-demo/actions.ts#addUserAction"
          // (in both dev and production thanks to $$id resolution)
          const isUserAction = actionId?.includes("loaders-demo/actions");

          console.log("actionId", {
            actionId,
            isUserAction,
          });

          return isUserAction ?? stale ?? defaultShouldRevalidate;
        }),
      ]),

      // Index route - demonstrates useLoader
      route("index", () => <LoadersIndexPage />),

      // Stats route - demonstrates useFetchLoader
      route("stats", () => <LoadersStatsPage />),
    ]),
  ]
);
