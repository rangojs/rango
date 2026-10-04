import { urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * Regression: revalidate(() => false) on a route-scoped parallel() slot must
 * not blank the slot on the soft navigation that first introduces it.
 *
 * Workerd twin of packages/rangojs-router/e2e/test-app/src/urls/
 * parallel-new-slot-reval.tsx. Pre-fix, arriving at /with-slot from the
 * sibling /no-slot sent a partial request whose client segment set had no
 * @panel id; the resolver seeded "new-segment" (render it) and then let the
 * user's hard `false` lower it back to skip, emitting component:null for a slot
 * the client had nothing cached for. A direct load rendered it fine.
 */
export const parallelNewSlotRevalPatterns = urls(
  ({ path, layout, parallel, revalidate }) => [
    layout(
      () => (
        <div data-testid="cf-new-slot-reval-layout">
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/with-slot",
          () => (
            <div data-testid="cf-new-slot-reval-with-slot">
              <h1>With slot</h1>
              {/* Route-scoped slot: the outlet lives in the route's own subtree. */}
              <ParallelOutlet name="@panel" />
              <Link
                to="/parallel-new-slot-reval/no-slot"
                data-testid="cf-new-slot-reval-link-to-no-slot"
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
                  <div data-testid="cf-new-slot-reval-panel">PANEL</div>
                ),
              },
              // The exact opt-out that used to blank the slot.
              () => [revalidate(() => false)],
            ),
          ],
        ),

        path(
          "/no-slot",
          () => (
            <div data-testid="cf-new-slot-reval-no-slot">
              <h1>No slot</h1>
              <Link
                to="/parallel-new-slot-reval/with-slot"
                data-testid="cf-new-slot-reval-link-to-with-slot"
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
