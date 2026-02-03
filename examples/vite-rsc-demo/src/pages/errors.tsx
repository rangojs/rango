import type { ErrorBoundaryFallbackProps, NotFoundBoundaryFallbackProps } from "@rangojs/router";
import { notFound } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { ClientErrorThrower } from "../components/ClientErrorThrower.js";

export function ErrorsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "20px" }}>
      <h1>Error &amp; NotFound Boundary Test Routes</h1>
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
      <Outlet />
    </div>
  );
}

export function ErrorsIndexPage() {
  return (
    <div>
      <h2>Error &amp; NotFound Boundary Test Index</h2>
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
  );
}

export function ErrorsLoaderErrorPage() {
  return (
    <div>
      <h2>Loader Data Page</h2>
      <p>This should not render because the loader fails</p>
    </div>
  );
}

export function ErrorsNotFoundLoaderPage() {
  return (
    <div>
      <h2>Loader Data Page</h2>
      <p>This should not render because the loader throws notFound()</p>
    </div>
  );
}

export function ErrorsClientErrorPage() {
  return <ClientErrorThrower />;
}

export function errorsErrorBoundary({ error }: ErrorBoundaryFallbackProps) {
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

export function errorsNotFoundBoundary({ notFound }: NotFoundBoundaryFallbackProps) {
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
