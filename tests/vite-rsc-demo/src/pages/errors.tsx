import type {
  ErrorBoundaryFallbackProps,
  NotFoundBoundaryFallbackProps,
} from "@rangojs/router";
import { notFound } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ClientErrorThrower } from "../components/ClientErrorThrower.js";
import {
  RevalidationControls,
  RevalidationLocalPage,
  RevalidationRouteBoundaryPage,
} from "../components/RevalidationDemo.js";

export function ErrorsLayout() {
  return (
    <div style={{ padding: "20px" }}>
      <h1>Error &amp; NotFound Boundary Test Routes</h1>
      <nav style={{ marginBottom: "20px" }}>
        <a href="/errors">Index</a> | <a href="/errors/throw">Handler Error</a>{" "}
        | <a href="/errors/loader-error">Loader Error</a> |{" "}
        <a href="/errors/not-found">NotFound (Handler)</a> |{" "}
        <a href="/errors/not-found-loader">NotFound (Loader)</a> |{" "}
        <a href="/errors/unhandled">Unhandled (Root Boundary)</a> |{" "}
        <a href="/errors/client-error">Client Error</a> |{" "}
        <a href="/errors/revalidation">Action Revalidation</a>
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
      <p>
        This page works correctly. Click the links above to test error
        scenarios:
      </p>
      <ul>
        <li>
          <strong>Handler Error:</strong> The route handler throws an error
        </li>
        <li>
          <strong>Loader Error:</strong> A loader throws an error during data
          fetching
        </li>
        <li>
          <strong>NotFound (Handler):</strong> The route handler throws
          notFound()
        </li>
        <li>
          <strong>NotFound (Loader):</strong> A loader throws notFound() during
          data fetching
        </li>
        <li>
          <strong>Unhandled (Root Boundary):</strong> Error without route error
          boundary - caught by root
        </li>
        <li>
          <strong>Client Error:</strong> A client component throws an error
          during interaction
        </li>
        <li>
          <strong>Action Revalidation:</strong> A server action succeeds, and a
          loader its revalidation reruns throws: the action resolves, the loader
          throws at its read, and the nearest boundary catches it
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
    <div
      style={{
        padding: "20px",
        backgroundColor: "#fee",
        border: "1px solid #f00",
      }}
    >
      <h2>Something went wrong</h2>
      <p>
        <strong>Error:</strong> {error.message}
      </p>
      <p>
        <strong>Type:</strong> {error.name}
      </p>
      <p>
        <strong>Segment:</strong> {error.segmentId} ({error.segmentType})
      </p>
      {error.stack && (
        <pre
          style={{
            overflow: "auto",
            fontSize: "12px",
            backgroundColor: "#fff",
          }}
        >
          {error.stack}
        </pre>
      )}
      <a href="/errors">
        <button type="button">Go back to error test index</button>
      </a>
    </div>
  );
}

export function errorsNotFoundBoundary({
  notFound,
}: NotFoundBoundaryFallbackProps) {
  return (
    <div
      style={{
        padding: "20px",
        backgroundColor: "#fffbe6",
        border: "1px solid #faad14",
      }}
    >
      <h2>Resource Not Found</h2>
      <p>
        <strong>Message:</strong> {notFound.message}
      </p>
      <p>
        <strong>Segment:</strong> {notFound.segmentId} ({notFound.segmentType})
      </p>
      {notFound.pathname && (
        <p>
          <strong>Path:</strong> {notFound.pathname}
        </p>
      )}
      <a href="/errors">
        <button type="button">Go back to error test index</button>
      </a>
    </div>
  );
}

/**
 * /errors/revalidation: a Save action succeeds, and the stock loader its
 * revalidation reruns throws while the toggle is on. The controls sit here,
 * outside every boundary the stock read can fail into.
 */
export function RevalidationDemoLayout() {
  return (
    <div data-testid="rv-demo">
      <h2>A loader that throws in an action&apos;s revalidation</h2>
      <p>
        Turn the toggle on, then Save. The action resolves (its result shows
        below), the stock list&apos;s loader throws at its{" "}
        <code>useLoader</code> read, and the nearest boundary to that read
        catches it. <code>useAction(saveNote).revalidationError</code> reports
        the error. Turn the toggle off and Save again: the stock list comes
        back.
      </p>
      <nav style={{ marginBottom: "12px" }}>
        <Link to="/errors/revalidation" data-testid="rv-nav-local">
          urls(): local ErrorBoundary
        </Link>{" "}
        |{" "}
        <Link to="/errors/revalidation/loading" data-testid="rv-nav-loading">
          urls() with loading(): local ErrorBoundary
        </Link>{" "}
        |{" "}
        <Link
          to="/errors/revalidation/route-boundary"
          data-testid="rv-nav-route-boundary"
        >
          urls(): the route&apos;s errorBoundary()
        </Link>{" "}
        |{" "}
        <Link to="/errors/revalidation/group" data-testid="rv-nav-group">
          clientUrls() group: local ErrorBoundary
        </Link>
      </nav>
      <RevalidationControls />
      <Outlet />
    </div>
  );
}

export function RevalidationLocal() {
  return (
    <RevalidationLocalPage title="urls(): a local React ErrorBoundary around the read" />
  );
}

export function RevalidationLocalLoading() {
  return (
    <RevalidationLocalPage title="urls() with loading(): a local React ErrorBoundary around the read" />
  );
}

export function RevalidationRouteBoundary() {
  return <RevalidationRouteBoundaryPage />;
}

/** The stock route's own errorBoundary(), in place of the route's content. */
export function revalidationStockErrorBoundary({
  error,
}: ErrorBoundaryFallbackProps) {
  return (
    <div
      data-testid="rv-route-fallback"
      style={{
        padding: "12px",
        backgroundColor: "#fee",
        border: "1px solid #f00",
        borderRadius: "6px",
      }}
    >
      <strong>The route&apos;s errorBoundary():</strong>{" "}
      <span data-testid="rv-route-fallback-message">{error.message}</span>
      <p>Turn the toggle off and Save again: this fallback clears.</p>
    </div>
  );
}
