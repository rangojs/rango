import type { ReactNode } from "react";
import { notFound, type Handler } from "@rangojs/router";
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
      <li>
        <Link
          to="/errors/streaming-declared"
          data-testid="streaming-declared-link"
        >
          Streaming Error (declared boundary)
        </Link>
      </li>
      <li>
        <Link
          to="/errors/streaming-declared-no-ssr"
          data-testid="streaming-declared-no-ssr-link"
        >
          Streaming Error (declared boundary, ssr: false)
        </Link>
      </li>
      <li>
        <Link to="/errors/slot-ancestor" data-testid="slot-ancestor-link">
          Slot failure (ancestor boundary)
        </Link>
      </li>
      <li>
        <Link
          to="/errors/streaming-not-found"
          data-testid="streaming-not-found-link"
        >
          Streaming notFound (declared boundary)
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

export const ErrorsStreamingDeclaredHandler: Handler<
  "errors.streamingDeclared"
> = async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  throw new Error("Streaming declared: thrown after the response started");
};

export const ErrorsStreamingDeclaredNoSsrHandler: Handler<
  "errors.streamingDeclaredNoSsr"
> = async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  throw new Error("Streaming declared ssr false: thrown after the shell");
};

export const ErrorsStreamingNotFoundHandler: Handler<
  "errors.streamingNotFound"
> = async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  notFound("Streaming notFound: thrown after the response started");
};

let flakyFailing = true;

/** Every flaky run fails until healed (a capture or re-render fails too). */
export const ErrorsFlakyResetHandler = (): { ok: true } => {
  flakyFailing = true;
  return { ok: true };
};

export const ErrorsFlakyHealHandler = (): { ok: true } => {
  flakyFailing = false;
  return { ok: true };
};

const flaky = () => async (): Promise<ReactNode> => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (flakyFailing) throw new Error("Flaky: failing until healed");
  return <div data-testid="flaky-healthy">healthy</div>;
};

export const ErrorsFlakyCacheHandler = flaky();
export const ErrorsFlakyPprHandler = flaky();

export const ErrorsSlotFailingHandler = async (): Promise<ReactNode> => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  throw new Error("Slot failed after the response started");
};
