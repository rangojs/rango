import { urls, Meta, revalidate } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

/**
 * Regression fixture for the stale-handle-bucket bug: a layout-mounted
 * parallel slot pushes Meta when an :item param is present and returns
 * null (without pushing) otherwise. On a soft-nav from "/foo" → "/" the
 * slot revalidates (its revalidate fn opts in on :item change) and the
 * handler runs but skips the Meta push. Without the cleanup fix, the
 * slot's previous bucket lingers and the document title stays stuck on
 * the prior :item's title.
 */
export const parallelMetaStalePatterns = urls(({ path, layout, parallel }) => [
  layout(
    (ctx) => {
      ctx.use(Meta)({
        title: { template: "%s | Stale Test", default: "Stale Test" },
      });
      return (
        <div data-testid="pm-stale-layout">
          <nav>
            <Link to="/parallel-meta-stale" data-testid="pm-stale-link-index">
              Index
            </Link>
            {" | "}
            <Link to="/parallel-meta-stale/foo" data-testid="pm-stale-link-foo">
              Foo
            </Link>
            {" | "}
            <Link to="/parallel-meta-stale/bar" data-testid="pm-stale-link-bar">
              Bar
            </Link>
          </nav>
          <Outlet />
        </div>
      );
    },
    () => [
      // Layout-mounted parallel slot. Revalidates whenever :item changes,
      // including when transitioning to a path WITHOUT :item. Pushes Meta
      // only when :item is present.
      parallel(
        {
          "@detail": (ctx) => {
            const item = ctx.params.item;
            if (!item) return null;
            const label = item[0].toUpperCase() + item.slice(1);
            ctx.use(Meta)({ title: label });
            return null;
          },
        },
        () => [
          revalidate(({ currentParams, nextParams }) => {
            if (currentParams?.item !== nextParams?.item) return true;
          }),
        ],
      ),
      path("/", () => <div data-testid="pm-stale-index">Index</div>, {
        name: "index",
      }),
      path(
        "/:item",
        (ctx) => <div data-testid="pm-stale-item">Item: {ctx.params.item}</div>,
        { name: "item" },
      ),
    ],
  ),
]);
