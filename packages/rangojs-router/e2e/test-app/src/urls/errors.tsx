import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ClientErrorThrower } from "../components/ClientErrorThrower.js";

/**
 * Error test routes URL patterns
 * Routes: errors.index, errors.clientError, errors.serverError, errors.streamingError
 */
export const errorsPatterns = urls(({ path, loading }) => [
  // Error test routes index
  path(
    "/errors",
    () => (
      <div data-testid="errors-index-page">
        <Link to="/" data-testid="back-link">
          ← Back to Home
        </Link>
        <h1 data-testid="errors-title">Error Boundary Tests</h1>
        <p data-testid="errors-description">
          Test error boundary behavior in different scenarios.
        </p>
        <ul data-testid="error-links">
          <li>
            <Link to="/errors/client-error" data-testid="client-error-link">
              Client Component Error
            </Link>
          </li>
          <li>
            <Link to="/errors/server-error" data-testid="server-error-link">
              Server Component Error
            </Link>
          </li>
          <li>
            <Link to="/errors/streaming-error" data-testid="streaming-error-link">
              Streaming Error
            </Link>
          </li>
        </ul>
      </div>
    ),
    { name: "errors.index" }
  ),

  // Route that renders a client component which throws an error on button click
  path(
    "/errors/client-error",
    () => (
      <div data-testid="client-error-page">
        <Link to="/errors" data-testid="back-link">
          ← Back to Error Tests
        </Link>
        <h1 data-testid="client-error-title">Client Component Error Test</h1>
        <p data-testid="client-error-description">
          This page renders a client component that throws an error when triggered.
        </p>
        <ClientErrorThrower testId="client-error-thrower" />
      </div>
    ),
    { name: "errors.clientError" }
  ),

  // Route that throws a server error during render
  path(
    "/errors/server-error",
    () => {
      throw new Error("Server error: This error was thrown during server-side render");
      return (
        <div data-testid="server-error-page">
          This should never render
        </div>
      );
    },
    { name: "errors.serverError" }
  ),

  // Route that throws an error during streaming (async render)
  path(
    "/errors/streaming-error",
    async () => {
      // Simulate async work then throw
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("Streaming error: This error was thrown during async streaming");
      return (
        <div data-testid="streaming-error-page">
          This should never render
        </div>
      );
    },
    { name: "errors.streamingError" },
    () => [
      loading(
        <div data-testid="streaming-error-loading">
          <p>Loading streaming content...</p>
        </div>
      ),
    ]
  ),
]);
