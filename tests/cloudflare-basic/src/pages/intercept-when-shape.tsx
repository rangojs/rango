import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

/**
 * Cloudflare-basic mirror of the router e2e app's intercept-when-shape
 * fixture: intercept()'s `when` sees `from` / `to` as { url, params,
 * routeName }. The modal opens only from the list's "open" section
 * (from.url, from.routeName, from.params) and never for item "skip"
 * (to.params); for item "throw" the selector throws and the full page
 * renders.
 */

function IwsShell() {
  return (
    <div data-testid="iws-shell">
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

const IwsList: Handler<"interceptWhenShape.list"> = (ctx) => (
  <div data-testid="iws-list">
    <span data-testid="iws-section">{ctx.params.section}</span>
    <Link to="/intercept-when-shape/item/1" data-testid="iws-to-1">
      1
    </Link>
    <Link to="/intercept-when-shape/item/skip" data-testid="iws-to-skip">
      skip
    </Link>
    <Link to="/intercept-when-shape/item/throw" data-testid="iws-to-throw">
      throw
    </Link>
  </div>
);

const IwsItem: Handler<"interceptWhenShape.item"> = (ctx) => (
  <div data-testid="iws-item-page">{ctx.params.id}</div>
);

export const interceptWhenShapePatterns = urls(
  ({ path, layout, intercept }) => [
    layout(IwsShell, () => [
      path("/list/:section", IwsList, { name: "list" }),
      path("/item/:id", IwsItem, { name: "item" }),
      intercept(
        "@modal",
        ".item",
        (ctx) => (
          <div role="dialog" data-testid="iws-modal">
            <span data-testid="iws-modal-id">{ctx.params.id}</span>
          </div>
        ),
        {
          when: ({ from, to }) => {
            if (to.params.id === "throw") throw new Error("iws selector throw");
            return (
              from.url.pathname.startsWith("/intercept-when-shape/list/") &&
              from.routeName === "interceptWhenShape.list" &&
              from.params.section === "open" &&
              to.routeName === "interceptWhenShape.item" &&
              to.params.id !== "skip"
            );
          },
        },
      ),
    ]),
  ],
);
