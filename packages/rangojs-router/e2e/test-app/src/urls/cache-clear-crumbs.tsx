import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { CacheClearCrumbs } from "./cache-clear-crumbs.defs.js";
import { CacheClearCrumbsBar } from "./cache-clear-crumbs.client.js";

// e2e/cache.test.ts "cache-clear-crumbs". The layout re-runs on every
// navigation (revalidate(() => true)) and pushes its crumb only when the
// request asks for it. A navigation that holds the layout must clear the crumb
// the layout's previous render pushed, on a HIT of the cache() record as on
// the MISS that wrote it: the HIT sends the layout's stored copy, which pushed
// nothing, and names it in resolvedIds.
/** The layout's handler runs in this server process, shown on the page. */
let layoutRuns = 0;

export const cacheClearCrumbsPatterns = urls(
  ({ path, layout, cache, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx) => {
          layoutRuns += 1;
          if (ctx.searchParams.get("cc") === "1") {
            ctx.use(CacheClearCrumbs)("layout");
          }
          return (
            <div data-testid="ccc-layout">
              <p data-testid="ccc-layout-runs">{layoutRuns}</p>
              <CacheClearCrumbsBar />
              <Outlet />
            </div>
          );
        },
        () => [
          revalidate(() => true),
          path(
            "/",
            () => (
              <div data-testid="ccc-index">
                <Link
                  to="/cache-clear-crumbs/item/a"
                  prefetch="none"
                  data-testid="ccc-link"
                >
                  A
                </Link>
              </div>
            ),
            { name: "index" },
          ),
          path(
            "/item/:id",
            (ctx) => (
              <>
                <div data-testid="ccc-detail">detail {ctx.params.id}</div>
                <Link
                  to="/cache-clear-crumbs?cc=1"
                  prefetch="none"
                  data-testid="ccc-back"
                >
                  back
                </Link>
              </>
            ),
            { name: "item" },
          ),
        ],
      ),
    ]),
  ],
);
