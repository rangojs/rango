import { redirect, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { SlotRedirectDelete } from "./slot-redirect.client.js";
import { slotRedirectItemIsDeleted } from "./slot-redirect.store.js";

// An item page whose parallel() slot declares loading() and, once the item is
// deleted, redirects from its async handler: the action that deletes it must
// answer with a redirect the browser follows, as a route handler under
// loading() does. Mounted at /slot-redirect.
// Body: tests/shared-e2e/src/slot-redirect-scenario.ts.
function SlotRedirectLayout() {
  return <Outlet />;
}

export const slotRedirectPatterns = urls(
  ({ layout, path, parallel, loading }) => [
    layout(SlotRedirectLayout, () => [
      path(
        "/list",
        () => (
          <div data-testid="sr-list">
            <Link
              to="/slot-redirect/item"
              prefetch="none"
              data-testid="sr-to-item"
            >
              Item
            </Link>
          </div>
        ),
        { name: "list" },
      ),
      path(
        "/item",
        () => (
          <div data-testid="sr-item-page">
            <Outlet name="@side" />
          </div>
        ),
        { name: "item" },
        () => [
          // Deleted, the slot sends the browser to the list.
          parallel(
            {
              "@side": async () => {
                // Pending past the first flush on a navigation, as a handler
                // that awaits I/O is: a promise already settled when the
                // response starts surfaces its Response through Flight's error
                // path instead.
                await new Promise((resolve) => setTimeout(resolve, 10));
                if (slotRedirectItemIsDeleted()) {
                  return redirect("/slot-redirect/list");
                }
                return (
                  <div data-testid="sr-side">
                    <SlotRedirectDelete />
                  </div>
                );
              },
            },
            () => [loading(<p data-testid="sr-loading">Loading</p>)],
          ),
        ],
      ),
    ]),
  ],
);
