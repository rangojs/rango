import { map, createLoader, notFound } from "@ivogt/rsc-router/server";
import type { errorRoutes } from "../routes.js";
import type { ErrorBoundaryFallbackProps, NotFoundBoundaryFallbackProps } from "@ivogt/rsc-router";
import { Outlet } from "@ivogt/rsc-router/client";
import { ClientErrorThrower } from "../components/ClientErrorThrower.js";

/**
 * Error fallback component that shows error info.
 * Uses a regular anchor tag for navigation since this is a server component.
 * For interactive reset functionality (without full page reload),
 * use a client component wrapper with the router's refresh mechanism.
 */
function ErrorFallback({ error }: ErrorBoundaryFallbackProps) {
  return (
    <div style={{ padding: "20px", backgroundColor: "#fee", border: "1px solid #f00" }}>
      <h2>Something went wrong</h2>
      <p><strong>Error:</strong> {error.message}</p>
      <p><strong>Type:</strong> {error.name}</p>
      <p><strong>Segment:</strong> {error.segmentId} ({error.segmentType})</p>
      {error.stack && (
        <pre style={{ overflow: "auto", fontSize: "12px", backgroundColor: "#fff" }}>
          {error.stack}
        </pre>
      )}
      <a href="/errors">
        <button type="button">Go back to error test index</button>
      </a>
    </div>
  );
}

/**
 * Simple static error fallback
 */
const SimpleErrorFallback = (
  <div style={{ padding: "20px", backgroundColor: "#fee", border: "1px solid #f00" }}>
    <h2>Error Loading Content</h2>
    <p>We encountered an error while loading this page.</p>
    <a href="/errors">Go back to error test index</a>
  </div>
);

/**
 * Loader that deliberately throws an error
 */
const FailingLoader = createLoader(async () => {
  throw new Error("Simulated loader failure - database connection timeout");
});

/**
 * Loader that throws notFound()
 */
const NotFoundLoader = createLoader(async () => {
  // Simulate checking for a resource that doesn't exist
  const resource = null; // Simulating resource not found in database
  if (!resource) {
    throw notFound("The requested resource was not found in the database");
  }
  return resource;
});

/**
 * NotFound fallback component that shows not found info.
 */
function NotFoundFallback({ notFound }: NotFoundBoundaryFallbackProps) {
  return (
    <div style={{ padding: "20px", backgroundColor: "#fffbe6", border: "1px solid #faad14" }}>
      <h2>Resource Not Found</h2>
      <p><strong>Message:</strong> {notFound.message}</p>
      <p><strong>Segment:</strong> {notFound.segmentId} ({notFound.segmentType})</p>
      {notFound.pathname && <p><strong>Path:</strong> {notFound.pathname}</p>}
      <a href="/errors">
        <button type="button">Go back to error test index</button>
      </a>
    </div>
  );
}

/**
 * Simple static not found fallback
 */
const SimpleNotFoundFallback = (
  <div style={{ padding: "20px", backgroundColor: "#fffbe6", border: "1px solid #faad14" }}>
    <h2>Content Not Found</h2>
    <p>The content you're looking for doesn't exist.</p>
    <a href="/errors">Go back to error test index</a>
  </div>
);

/**
 * Error test layout with error boundary
 */
function ErrorTestLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "20px" }}>
      <h1>Error & NotFound Boundary Test Routes</h1>
      <nav style={{ marginBottom: "20px" }}>
        <a href="/errors">Index</a> |{" "}
        <a href="/errors/throw">Handler Error</a> |{" "}
        <a href="/errors/loader-error">Loader Error</a> |{" "}
        <a href="/errors/not-found">NotFound (Handler)</a> |{" "}
        <a href="/errors/not-found-loader">NotFound (Loader)</a> |{" "}
        <a href="/errors/unhandled">Unhandled (Root Boundary)</a> |{" "}
        <a href="/errors/client-error">Client Error</a>
      </nav>
      <hr />
      {children}
    </div>
  );
}

/**
 * Error handlers - demonstrates error boundary and notFound boundary features
 * Tests server-side error/notFound capture and fallback UI rendering
 */
export default map<typeof errorRoutes>(
  ({ route, layout, errorBoundary, notFoundBoundary, loader }) => [
    // Note: RootLayout is now used as the document component in router.tsx

    // Unhandled error route - NO error boundary in parent chain
    // This tests the root ErrorBoundary added by renderSegments
    route("errors.unhandled", () => {
      throw new Error("This error is NOT caught by any route error boundary - it bubbles to root");
    }),

    // Error test layout with global error boundary and notFound boundary
    // Routes must be inside the layout's use() callback to inherit the boundaries
    layout(
      <ErrorTestLayout>
        <Outlet />
      </ErrorTestLayout>,
      () => [
        // Global error boundary catches all errors in this subtree
        errorBoundary(ErrorFallback),
        // Global notFound boundary catches all notFound() in this subtree
        notFoundBoundary(NotFoundFallback),

        // Index route - works fine, no error
        route("errors.index", () => (
          <div>
            <h2>Error & NotFound Boundary Test Index</h2>
            <p>This page works correctly. Click the links above to test error scenarios:</p>
            <ul>
              <li>
                <strong>Handler Error:</strong> The route handler throws an error
              </li>
              <li>
                <strong>Loader Error:</strong> A loader throws an error during data fetching
              </li>
              <li>
                <strong>NotFound (Handler):</strong> The route handler throws notFound()
              </li>
              <li>
                <strong>NotFound (Loader):</strong> A loader throws notFound() during data fetching
              </li>
              <li>
                <strong>Unhandled (Root Boundary):</strong> Error without route error boundary - caught by root
              </li>
              <li>
                <strong>Client Error:</strong> A client component throws an error during interaction
              </li>
            </ul>
          </div>
        )),

        // Route that throws an error in the handler
        route("errors.throwError", () => {
          // This error will be caught by the errorBoundary defined on the parent layout
          throw new Error("Simulated handler error - something went wrong!");
        }),

        // Route that has a failing loader - uses route-specific error boundary
        route(
          "errors.loaderError",
          () => (
            <div>
              <h2>Loader Data Page</h2>
              <p>This should not render because the loader fails</p>
            </div>
          ),
          () => [
            // This loader will throw
            loader(FailingLoader),
            // Route-specific error boundary (overrides parent)
            errorBoundary(SimpleErrorFallback),
          ]
        ),

        // Route that throws notFound() in the handler
        route("errors.notFound", () => {
          // This will be caught by the notFoundBoundary defined on the parent layout
          throw notFound("The requested page content was not found");
        }),

        // Route that has a loader which throws notFound() - uses route-specific boundary
        route(
          "errors.notFoundLoader",
          () => (
            <div>
              <h2>Loader Data Page</h2>
              <p>This should not render because the loader throws notFound()</p>
            </div>
          ),
          () => [
            // This loader will throw notFound()
            loader(NotFoundLoader),
            // Route-specific notFound boundary (overrides parent)
            notFoundBoundary(SimpleNotFoundFallback),
          ]
        ),

        // Route that renders a client component which throws an error
        // Tests the client-side ErrorBoundary behavior
        route("errors.clientError", () => <ClientErrorThrower />),
      ]
    ),
  ]
);
