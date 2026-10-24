import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// e2e/cache.test.ts "cache-intercept-routes" (rango-t194). cache() covers the
// layout, and two intercepts target the item route, each selected by its own
// when(): the modal from the index, the drawer from /other. Each keeps its own
// intercept: record, so opening the item from one source never serves the
// other source's intercept.
const INDEX = "/cache-intercept-when";
const OTHER = "/cache-intercept-when/other";

function Source({ name, to }: { name: string; to: string }) {
  return (
    <div data-testid={`ciw-${name}`}>
      <Link
        to="/cache-intercept-when/item/a"
        prefetch="none"
        data-testid={`ciw-${name}-item`}
      >
        A
      </Link>
      <Link to={to} prefetch="none" data-testid={`ciw-${name}-switch`}>
        switch
      </Link>
    </div>
  );
}

export const cacheInterceptWhenPatterns = urls(
  ({ path, layout, intercept, cache }) => [
    cache({ ttl: 600 }, () => [
      layout(
        () => (
          <div data-testid="ciw-layout">
            <Outlet />
            <Outlet name="@ciwModal" />
            <Outlet name="@ciwDrawer" />
          </div>
        ),
        () => [
          path("/", () => <Source name="index" to={OTHER} />, {
            name: "index",
          }),
          path("/other", () => <Source name="other" to={INDEX} />, {
            name: "other",
          }),
          path(
            "/item/:id",
            (ctx) => <div data-testid="ciw-detail">detail {ctx.params.id}</div>,
            { name: "item" },
          ),
          intercept(
            "@ciwModal",
            ".item",
            (ctx) => <div data-testid="ciw-modal">modal {ctx.params.id}</div>,
            { when: ({ from }) => from.url.pathname === INDEX },
          ),
          intercept(
            "@ciwDrawer",
            ".item",
            (ctx) => <div data-testid="ciw-drawer">drawer {ctx.params.id}</div>,
            { when: ({ from }) => from.url.pathname === OTHER },
          ),
        ],
      ),
    ]),
  ],
);
