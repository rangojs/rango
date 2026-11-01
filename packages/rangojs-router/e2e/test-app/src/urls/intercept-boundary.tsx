import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { InterceptBoundaryCartLoader } from "./intercept-boundary.defs.js";
import {
  InterceptBoundaryAdd,
  InterceptBoundaryBar,
  InterceptBoundaryItemControls,
} from "./intercept-boundary.client.js";

// An item opened as an intercept over a list, with a form whose action
// throws, under a layout with a cart count. The layout's errorBoundary() is
// the one that handles the intercept (it has none of its own). Mounted at /intercept-boundary. Body:
// tests/shared-e2e/src/intercept-boundary-scenario.ts.
function InterceptBoundaryLayout() {
  return (
    <div>
      <InterceptBoundaryBar />
      <Link
        to="/intercept-boundary/other"
        prefetch="none"
        data-testid="ib-to-other"
      >
        Other
      </Link>
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

function InterceptBoundaryFailed() {
  return <p data-testid="ib-boundary">The item failed</p>;
}

export const interceptBoundaryPatterns = urls(
  ({ layout, path, loader, intercept, errorBoundary }) => [
    layout(InterceptBoundaryLayout, () => [
      loader(InterceptBoundaryCartLoader),
      errorBoundary(InterceptBoundaryFailed),
      path(
        "/list",
        () => (
          <div data-testid="ib-list">
            <Link
              to="/intercept-boundary/item"
              prefetch="none"
              data-testid="ib-to-item"
            >
              Item
            </Link>
            <InterceptBoundaryAdd />
          </div>
        ),
        { name: "list" },
      ),
      path(
        "/item",
        () => (
          <div data-testid="ib-item-page">
            <InterceptBoundaryItemControls />
          </div>
        ),
        { name: "item" },
      ),
      path("/other", () => <div data-testid="ib-other">Other</div>, {
        name: "other",
      }),
      // Opened from the list, the item is a modal over it.
      intercept("@modal", ".item", () => (
        <div data-testid="ib-modal">
          <InterceptBoundaryItemControls />
        </div>
      )),
    ]),
  ],
);
