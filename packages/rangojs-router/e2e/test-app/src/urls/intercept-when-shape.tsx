import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { Modal } from "../components/Modal.js";

/**
 * intercept()'s `when` selector sees `from` / `to` as { url, params,
 * routeName }, the shape transition({ when }) sees (without `state`). The
 * modal opens only from the "open" section of the list (from.routeName +
 * from.params) and never for item "skip" (to.params). For item "throw" the
 * selector throws: no intercept, the full page renders.
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
          <Modal testId="iws-modal">
            <span data-testid="iws-modal-id">{ctx.params.id}</span>
          </Modal>
        ),
        {
          when: ({ from, to }) => {
            // A throwing selector renders the full page (no intercept).
            if (to.params.id === "throw") throw new Error("iws selector throw");
            return (
              from.routeName === "interceptWhenShape.list" &&
              from.params.section === "open" &&
              to.params.id !== "skip"
            );
          },
        },
      ),
    ]),
  ],
);
