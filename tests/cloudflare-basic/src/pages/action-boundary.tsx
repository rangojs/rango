import { Suspense } from "react";
import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ActionBoundaryCartLoader } from "./action-boundary.defs.js";
import {
  ActionBoundaryBar,
  ActionBoundaryControls,
  ActionBoundarySlowControls,
} from "./action-boundary.client.js";

// An action that throws on a route with its own errorBoundary(), under a
// layout whose loader reads what the action wrote (action-boundary.test.ts).
// Mounted at /action-boundary. Body:
// tests/shared-e2e/src/action-boundary-scenario.ts.
function ActionBoundaryLayout() {
  return (
    <div data-testid="ab-layout">
      <ActionBoundaryBar />
      <Link
        to="/action-boundary/other"
        prefetch="none"
        data-testid="ab-to-other"
      >
        Other
      </Link>
      <Outlet />
    </div>
  );
}

// Keeps the error response's Flight stream open after its first rows, so the
// action is still "streaming" when its response is processed (rango-t125).
async function ActionBoundaryTail() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return <span data-testid="ab-boundary-tail">done</span>;
}

function ActionBoundaryFallback() {
  return (
    <div>
      <p data-testid="ab-boundary">The page failed</p>
      <Suspense fallback={null}>
        <ActionBoundaryTail />
      </Suspense>
    </div>
  );
}

export const actionBoundaryPatterns = urls(
  ({ layout, path, loader, errorBoundary }) => [
    layout(ActionBoundaryLayout, () => [
      loader(ActionBoundaryCartLoader),
      path(
        "/page",
        () => (
          <div data-testid="ab-page">
            <ActionBoundaryControls />
          </div>
        ),
        { name: "page" },
        () => [errorBoundary(ActionBoundaryFallback)],
      ),
      path(
        "/other",
        () => (
          <div data-testid="ab-other">
            <ActionBoundarySlowControls />
          </div>
        ),
        { name: "other" },
      ),
    ]),
  ],
);
