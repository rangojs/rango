import { redirect, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { InterceptRedirectDelete } from "./intercept-redirect.client.js";
import { interceptRedirectItemIsDeleted } from "./intercept-redirect.store.js";

// An item opened as an intercept over a list. The intercept's handler declares
// loading() and, once the item is deleted, redirects from its async handler:
// the action that deletes it must answer with a redirect the browser follows,
// as a route handler under loading() does. Mounted at /intercept-redirect.
// Body: tests/shared-e2e/src/intercept-redirect-scenario.ts.
function InterceptRedirectLayout() {
  return (
    <div>
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

export const interceptRedirectPatterns = urls(
  ({ layout, path, intercept, loading }) => [
    layout(InterceptRedirectLayout, () => [
      path(
        "/list",
        () => (
          <div data-testid="ir-list">
            <Link
              to="/intercept-redirect/item"
              prefetch="none"
              data-testid="ir-to-item"
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
          <div data-testid="ir-item-page">
            <InterceptRedirectDelete />
          </div>
        ),
        { name: "item" },
      ),
      // Opened from the list, the item is a modal over it. Deleted, the modal
      // sends the browser to the list.
      intercept(
        "@modal",
        ".item",
        async () => {
          // Pending past the first flush, as a handler that awaits I/O is: a
          // promise already settled when the response starts surfaces its
          // Response through Flight's error path instead.
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (interceptRedirectItemIsDeleted()) {
            return redirect("/intercept-redirect/list");
          }
          return (
            <div data-testid="ir-modal">
              <InterceptRedirectDelete />
            </div>
          );
        },
        () => [loading(<p data-testid="ir-loading">Loading</p>)],
      ),
    ]),
  ],
);
