import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { IasDrawerAction } from "./intercept-action-select.client.js";
import { IasDrawerLoader } from "./intercept-action-select.defs.js";

// e2e/intercept-action-select.test.ts (rango-t200), the cloudflare-basic
// counterpart of the router e2e app's /cache-intercept-when drawer action.
// Two intercepts target the item route, each selected by its own when(): the
// modal from /list, declared first, and the drawer from /other, declared
// second, with a loader and a server action. A server action from the open
// drawer re-renders the drawer alone. A parallel() default fills the @modal
// slot, so the page holds the modal's slot id while the drawer is open: the
// action must still tell the two apart by when().
const LIST = "/intercept-action-select/list";
const OTHER = "/intercept-action-select/other";

function Source({ name }: { name: string }) {
  return (
    <div data-testid={`ias-${name}`}>
      <Link
        to="/intercept-action-select/item/a"
        prefetch="none"
        data-testid={`ias-${name}-item`}
      >
        A
      </Link>
    </div>
  );
}

export const interceptActionSelectPatterns = urls(
  ({ path, layout, parallel, intercept, loader }) => [
    layout(
      () => (
        <div data-testid="ias-layout">
          <Outlet />
          <Outlet name="@modal" />
          <Outlet name="@drawer" />
        </div>
      ),
      () => [
        parallel({
          "@modal": () => <div data-testid="ias-modal-default">no modal</div>,
        }),
        path("/list", () => <Source name="list" />, { name: "list" }),
        path("/other", () => <Source name="other" />, { name: "other" }),
        path(
          "/item/:id",
          (ctx) => <div data-testid="ias-detail">detail {ctx.params.id}</div>,
          { name: "item" },
        ),
        intercept(
          "@modal",
          ".item",
          (ctx) => <div data-testid="ias-modal">modal {ctx.params.id}</div>,
          { when: ({ from }) => from.url.pathname === LIST },
        ),
        intercept(
          "@drawer",
          ".item",
          (ctx) => (
            <>
              <div data-testid="ias-drawer">drawer {ctx.params.id}</div>
              <IasDrawerAction />
            </>
          ),
          { when: ({ from }) => from.url.pathname === OTHER },
          () => [loader(IasDrawerLoader)],
        ),
      ],
    ),
  ],
);
