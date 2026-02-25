"use client";

import { useState, useEffect, useActionState } from "react";
import {
  useLoader,
  useFetchLoader,
  ErrorBoundary,
  type LoaderDefinition,
} from "@rangojs/router/client";
import { UnregisteredLoader } from "../loaders.js";

// Type for the hook test loader data
interface HookTestLoaderData {
  routeId: string;
  count: number;
  source: string;
  timestamp: string;
}

// Props for components that need a loader passed from server
interface UseLoaderTestProps {
  loader: LoaderDefinition<HookTestLoaderData>;
}

interface UseFetchLoaderUnregisteredTestProps {
  loader: LoaderDefinition<{
    id: string;
    message: string;
    timestamp: string;
  }>;
}

interface ErrorLoaderTestProps {
  loader: LoaderDefinition<{
    message: string;
    timestamp: string;
  }>;
}

interface ProtectedLoaderTestProps {
  loader: LoaderDefinition<{
    secret: string;
    userId: string;
    timestamp: string;
  }>;
}

/**
 * Tests useLoader with pre-loaded data (loader registered on route)
 * - Should have data immediately (no undefined)
 * - Should update data on navigation
 */
export function UseLoaderTest({ loader }: UseLoaderTestProps) {
  const { data, load, isLoading, error } =
    useLoader<HookTestLoaderData>(loader);

  return (
    <div data-testid="use-loader-test">
      <h3>useLoader Test (Pre-loaded)</h3>

      <div data-testid="use-loader-data">
        <p data-testid="use-loader-route-id">Route ID: {data.routeId}</p>
        <p data-testid="use-loader-count">Count: {data.count}</p>
        <p data-testid="use-loader-source">Source: {data.source}</p>
        <p data-testid="use-loader-timestamp">Timestamp: {data.timestamp}</p>
      </div>

      {isLoading && <p data-testid="use-loader-loading">Loading...</p>}
      {error && <p data-testid="use-loader-error">Error: {error.message}</p>}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="use-loader-refetch-btn"
          onClick={() => load()}
          disabled={isLoading}
        >
          Refetch
        </button>
        <button
          data-testid="use-loader-fetch-custom-btn"
          onClick={() => load({ params: { routeId: "custom-via-load" } })}
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch Custom
        </button>
      </div>
    </div>
  );
}

/**
 * Tests useFetchLoader with pre-loaded data (loader registered on route)
 * - Should have data from context initially
 * - Data updates on navigation
 * - Can refetch via load()
 */
export function UseFetchLoaderPreloadedTest({ loader }: UseLoaderTestProps) {
  const { data, load, isLoading, error } =
    useFetchLoader<HookTestLoaderData>(loader);

  return (
    <div data-testid="use-fetch-loader-preloaded-test">
      <h3>useFetchLoader Test (Pre-loaded)</h3>

      {data ? (
        <div data-testid="use-fetch-loader-preloaded-data">
          <p data-testid="use-fetch-loader-preloaded-route-id">
            Route ID: {data.routeId}
          </p>
          <p data-testid="use-fetch-loader-preloaded-count">
            Count: {data.count}
          </p>
          <p data-testid="use-fetch-loader-preloaded-source">
            Source: {data.source}
          </p>
          <p data-testid="use-fetch-loader-preloaded-timestamp">
            Timestamp: {data.timestamp}
          </p>
        </div>
      ) : (
        <p data-testid="use-fetch-loader-preloaded-no-data">No data</p>
      )}

      {isLoading && (
        <p data-testid="use-fetch-loader-preloaded-loading">Loading...</p>
      )}
      {error && (
        <p data-testid="use-fetch-loader-preloaded-error">
          Error: {error.message}
        </p>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="use-fetch-loader-preloaded-refetch-btn"
          onClick={() => load()}
          disabled={isLoading}
        >
          Refetch
        </button>
        <button
          data-testid="use-fetch-loader-preloaded-fetch-custom-btn"
          onClick={() => load({ params: { routeId: "custom-fetched" } })}
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch Custom
        </button>
      </div>
    </div>
  );
}

/**
 * Tests useFetchLoader without pre-loaded data (loader NOT registered on route)
 * - Should have undefined data initially
 * - Can fetch on-demand via load()
 */
export function UseFetchLoaderUnregisteredTest({
  loader,
}: UseFetchLoaderUnregisteredTestProps) {
  const { data, load, isLoading, error } = useFetchLoader<{
    id: string;
    message: string;
    timestamp: string;
  }>(loader);

  return (
    <div data-testid="use-fetch-loader-unregistered-test">
      <h3>useFetchLoader Test (Unregistered - No Pre-load)</h3>

      {data ? (
        <div data-testid="use-fetch-loader-unregistered-data">
          <p data-testid="use-fetch-loader-unregistered-id">ID: {data.id}</p>
          <p data-testid="use-fetch-loader-unregistered-message">
            Message: {data.message}
          </p>
          <p data-testid="use-fetch-loader-unregistered-timestamp">
            Timestamp: {data.timestamp}
          </p>
        </div>
      ) : (
        <p data-testid="use-fetch-loader-unregistered-no-data">
          No data (not pre-loaded)
        </p>
      )}

      {isLoading && (
        <p data-testid="use-fetch-loader-unregistered-loading">Loading...</p>
      )}
      {error && (
        <p data-testid="use-fetch-loader-unregistered-error">
          Error: {error.message}
        </p>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="use-fetch-loader-unregistered-fetch-btn"
          onClick={() => load()}
          disabled={isLoading}
        >
          Fetch Data
        </button>
      </div>
    </div>
  );
}

/**
 * Tests useLoader with route B loader (for navigation tests)
 */
export function UseLoaderTestB({ loader }: UseLoaderTestProps) {
  const { data, isLoading } = useLoader<HookTestLoaderData>(loader);

  return (
    <div data-testid="use-loader-test-b">
      <h3>useLoader Test B (Navigation Target)</h3>

      <div data-testid="use-loader-data-b">
        <p data-testid="use-loader-route-id-b">Route ID: {data.routeId}</p>
        <p data-testid="use-loader-count-b">Count: {data.count}</p>
        <p data-testid="use-loader-source-b">Source: {data.source}</p>
        <p data-testid="use-loader-timestamp-b">Timestamp: {data.timestamp}</p>
      </div>

      {isLoading && <p data-testid="use-loader-loading-b">Loading...</p>}
    </div>
  );
}

/**
 * Tests useFetchLoader with route B loader (for navigation tests)
 */
export function UseFetchLoaderTestB({ loader }: UseLoaderTestProps) {
  const { data, isLoading } = useFetchLoader<HookTestLoaderData>(loader);

  return (
    <div data-testid="use-fetch-loader-test-b">
      <h3>useFetchLoader Test B (Navigation Target)</h3>

      {data ? (
        <div data-testid="use-fetch-loader-data-b">
          <p data-testid="use-fetch-loader-route-id-b">
            Route ID: {data.routeId}
          </p>
          <p data-testid="use-fetch-loader-count-b">Count: {data.count}</p>
          <p data-testid="use-fetch-loader-source-b">Source: {data.source}</p>
          <p data-testid="use-fetch-loader-timestamp-b">
            Timestamp: {data.timestamp}
          </p>
        </div>
      ) : (
        <p data-testid="use-fetch-loader-no-data-b">No data</p>
      )}

      {isLoading && <p data-testid="use-fetch-loader-loading-b">Loading...</p>}
    </div>
  );
}

/**
 * Tests error handling with useFetchLoader
 * - throwOnError: false allows capturing errors in state
 */
export function ErrorLoaderTest({ loader }: ErrorLoaderTestProps) {
  const { data, load, isLoading, error } = useFetchLoader<{
    message: string;
    timestamp: string;
  }>(loader, { throwOnError: false });

  return (
    <div data-testid="error-loader-test">
      <h3>Error Loader Test</h3>

      {data ? (
        <div data-testid="error-loader-data">
          <p data-testid="error-loader-message">Message: {data.message}</p>
        </div>
      ) : (
        <p data-testid="error-loader-no-data">No data</p>
      )}

      {isLoading && <p data-testid="error-loader-loading">Loading...</p>}
      {error && <p data-testid="error-loader-error">Error: {error.message}</p>}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="error-loader-trigger-error-btn"
          onClick={() => load({ params: { shouldFail: "true" } })}
          disabled={isLoading}
        >
          Trigger Error
        </button>
        <button
          data-testid="error-loader-success-btn"
          onClick={() => load({ params: { shouldFail: "false" } })}
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch Success
        </button>
      </div>
    </div>
  );
}

/**
 * Tests protected loader with middleware
 * - Should fail without valid auth token
 * - Should succeed with valid auth token
 */
export function ProtectedLoaderTest({ loader }: ProtectedLoaderTestProps) {
  const { data, load, isLoading, error } = useFetchLoader<{
    secret: string;
    userId: string;
    timestamp: string;
  }>(loader, { throwOnError: false });

  return (
    <div data-testid="protected-loader-test">
      <h3>Protected Loader Test (Middleware)</h3>

      {data ? (
        <div data-testid="protected-loader-data">
          <p data-testid="protected-loader-secret">Secret: {data.secret}</p>
          <p data-testid="protected-loader-user-id">User ID: {data.userId}</p>
        </div>
      ) : (
        <p data-testid="protected-loader-no-data">No data</p>
      )}

      {isLoading && <p data-testid="protected-loader-loading">Loading...</p>}
      {error && (
        <p data-testid="protected-loader-error">Error: {error.message}</p>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="protected-loader-unauthorized-btn"
          onClick={() => load({ params: { userId: "hacker" } })}
          disabled={isLoading}
        >
          Fetch (No Auth)
        </button>
        <button
          data-testid="protected-loader-invalid-token-btn"
          onClick={() =>
            load({ params: { authToken: "invalid", userId: "user1" } })
          }
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch (Invalid Token)
        </button>
        <button
          data-testid="protected-loader-authorized-btn"
          onClick={() =>
            load({ params: { authToken: "valid-token", userId: "user1" } })
          }
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch (Valid Auth)
        </button>
      </div>
    </div>
  );
}

/**
 * Inner component for testing useFetchLoader with throwOnError: true (default)
 */
function UnhandledErrorLoaderInner({ loader }: ErrorLoaderTestProps) {
  const { data, load, isLoading } = useFetchLoader<{
    message: string;
    timestamp: string;
  }>(loader); // No throwOnError option = defaults to true

  return (
    <div data-testid="unhandled-error-loader-inner">
      {data ? (
        <div data-testid="unhandled-error-loader-data">
          <p data-testid="unhandled-error-loader-message">
            Message: {data.message}
          </p>
        </div>
      ) : (
        <p data-testid="unhandled-error-loader-no-data">No data</p>
      )}

      {isLoading && (
        <p data-testid="unhandled-error-loader-loading">Loading...</p>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="unhandled-error-trigger-btn"
          onClick={() => load({ params: { shouldFail: "true" } })}
          disabled={isLoading}
        >
          Trigger Unhandled Error
        </button>
        <button
          data-testid="unhandled-error-success-btn"
          onClick={() => load({ params: { shouldFail: "false" } })}
          disabled={isLoading}
          style={{ marginLeft: "0.5rem" }}
        >
          Fetch Success
        </button>
      </div>
    </div>
  );
}

/**
 * Tests useFetchLoader with throwOnError: true (default)
 * - Errors should propagate to nearest error boundary
 * - Wrapped in the router's ErrorBoundary for isolated testing
 */
export function UnhandledErrorLoaderTest({ loader }: ErrorLoaderTestProps) {
  return (
    <div data-testid="unhandled-error-loader-test">
      <h3>Unhandled Error Test (throwOnError: true)</h3>
      <ErrorBoundary
        fallback={({ error }) => (
          <div data-testid="unhandled-error-error-boundary">
            <p data-testid="unhandled-error-error-message">
              Error: {error.message}
            </p>
          </div>
        )}
      >
        <UnhandledErrorLoaderInner loader={loader} />
      </ErrorBoundary>
    </div>
  );
}

/**
 * Inner component that uses useLoader with unregistered loader
 * This WILL throw because the loader data is not in context
 */
function UseLoaderThrowsInner({ loader }: UseLoaderTestProps) {
  // This will throw because HookTestLoader is NOT registered on this route
  const { data } = useLoader<HookTestLoaderData>(loader);

  return (
    <div data-testid="use-loader-throws-data">
      <p>Route ID: {data.routeId}</p>
      <p>This should never render</p>
    </div>
  );
}

/**
 * Tests that useLoader throws when data is not in context
 * Wrapped in ErrorBoundary to catch the throw
 * Uses client-only rendering to avoid SSR crash
 */
export function UseLoaderThrowsTest({ loader }: UseLoaderTestProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div data-testid="use-loader-throws-test">
      <h3>useLoader Throws Test (No Data in Context)</h3>
      {mounted ? (
        <ErrorBoundary
          fallback={({ error }) => (
            <div data-testid="use-loader-throws-error-boundary">
              <p data-testid="use-loader-throws-error-message">
                Error: {error.message}
              </p>
            </div>
          )}
        >
          <UseLoaderThrowsInner loader={loader} />
        </ErrorBoundary>
      ) : (
        <div data-testid="use-loader-throws-ssr-placeholder">Loading...</div>
      )}
    </div>
  );
}

/**
 * Tests isLoading state explicitly
 * Shows loading indicator during fetch
 */
export function IsLoadingTest({ loader }: UseFetchLoaderUnregisteredTestProps) {
  const { data, load, isLoading, error } = useFetchLoader<{
    id: string;
    message: string;
    timestamp: string;
  }>(loader);

  return (
    <div data-testid="is-loading-test">
      <h3>isLoading State Test</h3>

      <div data-testid="is-loading-status">
        isLoading: {isLoading ? "true" : "false"}
      </div>

      {data ? (
        <div data-testid="is-loading-data">
          <p data-testid="is-loading-message">Message: {data.message}</p>
        </div>
      ) : (
        <p data-testid="is-loading-no-data">No data</p>
      )}

      {error && <p data-testid="is-loading-error">Error: {error.message}</p>}

      <div style={{ marginTop: "1rem" }}>
        <button
          data-testid="is-loading-fetch-btn"
          onClick={() => load()}
          disabled={isLoading}
        >
          {isLoading ? "Loading..." : "Fetch Data"}
        </button>
      </div>
    </div>
  );
}

/**
 * Tests form action support with load.action (client-side state management)
 * This uses the hook's action wrapper for isLoading/error state tracking
 */
export function FormActionTest({
  loader,
}: UseFetchLoaderUnregisteredTestProps) {
  const { data, load, isLoading, error } = useFetchLoader<{
    id: string;
    message: string;
    timestamp: string;
  }>(loader);

  return (
    <div data-testid="form-action-test">
      <h3>Form Action Test (load.action)</h3>

      {data ? (
        <div data-testid="form-action-data">
          <p data-testid="form-action-message">Message: {data.message}</p>
          <p data-testid="form-action-id">ID: {data.id}</p>
        </div>
      ) : (
        <p data-testid="form-action-no-data">No data</p>
      )}

      {isLoading && <p data-testid="form-action-loading">Loading...</p>}
      {error && <p data-testid="form-action-error">Error: {error.message}</p>}

      <form
        data-testid="form-action-form"
        action={load.action}
        style={{ marginTop: "1rem" }}
      >
        <input type="hidden" name="id" value="form-submitted" />
        <button
          type="submit"
          data-testid="form-action-submit-btn"
          disabled={isLoading}
        >
          Submit Form
        </button>
      </form>
    </div>
  );
}

/**
 * Tests true progressive enhancement using loader.action directly
 * This uses the server action directly for no-JS support
 */
export function FormActionProgressiveTest({
  loader,
}: UseFetchLoaderUnregisteredTestProps) {
  // Use useActionState with the server action directly (not a wrapper)
  // The server action must be passed directly to preserve PE semantics
  const [state, formAction, isPending] = useActionState(
    loader.action!,
    null as { id: string; message: string; timestamp: string } | null,
  );

  return (
    <div data-testid="form-action-progressive-test">
      <h3>Form Action Test (Progressive Enhancement)</h3>

      {state ? (
        <div data-testid="form-action-progressive-data">
          <p data-testid="form-action-progressive-message">
            Message: {state.message}
          </p>
          <p data-testid="form-action-progressive-id">ID: {state.id}</p>
        </div>
      ) : (
        <p data-testid="form-action-progressive-no-data">No data</p>
      )}

      {isPending && (
        <p data-testid="form-action-progressive-loading">Loading...</p>
      )}

      <form
        data-testid="form-action-progressive-form"
        action={formAction}
        style={{ marginTop: "1rem" }}
      >
        <input type="hidden" name="id" value="form-submitted-progressive" />
        <button
          type="submit"
          data-testid="form-action-progressive-submit-btn"
          disabled={isPending}
        >
          Submit Form (PE)
        </button>
      </form>
    </div>
  );
}

/**
 * Tests load.action with a directly imported loader (not passed as prop).
 * This is the pattern where a client component imports the loader module
 * directly instead of receiving the loader definition through Flight props.
 */
export function DirectImportFormActionTest() {
  const { data, load, isLoading } = useFetchLoader<{
    id: string;
    message: string;
    timestamp: string;
  }>(UnregisteredLoader);

  return (
    <div data-testid="direct-import-form-action-test">
      <h3>Direct Import Form Action Test</h3>

      {data ? (
        <div data-testid="direct-import-data">
          <p data-testid="direct-import-message">Message: {data.message}</p>
          <p data-testid="direct-import-id">ID: {data.id}</p>
        </div>
      ) : (
        <p data-testid="direct-import-no-data">No data</p>
      )}

      {isLoading && <p data-testid="direct-import-loading">Loading...</p>}

      <form
        data-testid="direct-import-form"
        action={load.action}
        style={{ marginTop: "1rem" }}
      >
        <input type="hidden" name="id" value="direct-import-submitted" />
        <button
          type="submit"
          data-testid="direct-import-submit-btn"
          disabled={isLoading}
        >
          Submit (Direct Import)
        </button>
      </form>
    </div>
  );
}
