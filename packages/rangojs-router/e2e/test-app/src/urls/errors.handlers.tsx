import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ClientErrorThrower } from "../components/ClientErrorThrower.js";

export const ErrorsIndexHandler: Handler<"errors.index"> = () => (
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
);

export const ErrorsClientErrorHandler: Handler<"errors.clientError"> = () => (
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
);

export const ErrorsServerErrorHandler: Handler<"errors.serverError"> = () => {
  throw new Error(
    "Server error: This error was thrown during server-side render",
  );
  return <div data-testid="server-error-page">This should never render</div>;
};

export const ErrorsStreamingErrorHandler: Handler<
  "errors.streamingError"
> = async () => {
  // Simulate async work then throw
  await new Promise((resolve) => setTimeout(resolve, 500));
  throw new Error(
    "Streaming error: This error was thrown during async streaming",
  );
  return <div data-testid="streaming-error-page">This should never render</div>;
};

/**
 * Async server component that throws during RSC serialization.
 * The handler below returns JSX containing this component — the handler
 * itself succeeds, but React's renderToReadableStream hits the error
 * when it tries to serialize this async component.
 */
async function ThrowDuringSerialization() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error("RSC serialization error for onError test");
}

export function ErrorsRenderingErrorHandler() {
  return (
    <div data-testid="rendering-error-page">
      <h1>Rendering Error Test</h1>
      {/* @ts-expect-error async server component */}
      <ThrowDuringSerialization />
    </div>
  );
}
