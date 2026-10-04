import { urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * Regression fixture for the floored "new-segment" seed — see the
 * `defaultOverride` floor in src/router/segment-resolution/revalidation.ts.
 *
 * /with-slot owns a ROUTE-scoped @panel carrying revalidate(() => false);
 * /no-slot is a sibling under the same layout without it. Arriving from
 * /no-slot is the only way to reach /with-slot with @panel absent from the
 * request's client segment set, which is what used to blank the slot.
 */
export const parallelNewSlotRevalPatterns = urls(
  ({ path, layout, parallel, revalidate }) => [
    layout(
      () => (
        <div data-testid="new-slot-reval-layout">
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/parallel-new-slot-reval/with-slot",
          () => (
            <div data-testid="new-slot-reval-with-slot">
              <h1>With slot</h1>
              {/* Route-scoped slot: the outlet lives in the route's own
                  subtree, mirroring tests/vite-rsc-demo's ShopIndexRoute. */}
              <ParallelOutlet name="@panel" />
              <Link
                to="/parallel-new-slot-reval/no-slot"
                data-testid="new-slot-reval-link-to-no-slot"
              >
                Go to no-slot
              </Link>
            </div>
          ),
          { name: "withSlot" },
          () => [
            parallel(
              {
                "@panel": () => (
                  <div data-testid="new-slot-reval-panel">PANEL</div>
                ),
              },
              // The exact opt-out that used to blank the slot.
              () => [revalidate(() => false)],
            ),
          ],
        ),

        path(
          "/parallel-new-slot-reval/no-slot",
          () => (
            <div data-testid="new-slot-reval-no-slot">
              <h1>No slot</h1>
              <Link
                to="/parallel-new-slot-reval/with-slot"
                data-testid="new-slot-reval-link-to-with-slot"
              >
                Go to with-slot
              </Link>
            </div>
          ),
          { name: "noSlot" },
        ),
      ],
    ),
  ],
);
