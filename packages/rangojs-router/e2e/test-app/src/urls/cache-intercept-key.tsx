import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// e2e/cache.test.ts "cache-intercept-routes". A cache() with its
// own key() covers the layout, and an intercept targets the item route from
// the index. The key() names the path alone, so a document request, a plain
// navigation (from /plain, where the intercept's when() fails) and the
// intercept navigation to the item get one key() result: each must still keep
// its own record. The item page and the intercept render a run number, so an
// unchanged number is a HIT of the stored record.
const INDEX = "/cache-intercept-key";
const ITEM = "/cache-intercept-key/item/a";

let runs = 0;

function Source({ name }: { name: string }) {
  return (
    <div data-testid={`cik-${name}`}>
      <Link to={ITEM} prefetch="none" data-testid={`cik-${name}-item`}>
        A
      </Link>
    </div>
  );
}

export const cacheInterceptKeyPatterns = urls(
  ({ path, layout, intercept, cache }) => [
    cache({ ttl: 600, key: (ctx) => `cik:${ctx.url.pathname}` }, () => [
      layout(
        () => (
          <div data-testid="cik-layout">
            <Outlet />
            <Outlet name="@cikModal" />
          </div>
        ),
        () => [
          path("/", () => <Source name="index" />, { name: "index" }),
          path("/plain", () => <Source name="plain" />, { name: "plain" }),
          path(
            "/item/:id",
            (ctx) => (
              <div data-testid="cik-detail">
                detail {ctx.params.id}{" "}
                <span data-testid="cik-detail-run">{++runs}</span>
              </div>
            ),
            { name: "item" },
          ),
          intercept(
            "@cikModal",
            ".item",
            (ctx) => (
              <div data-testid="cik-modal">
                modal {ctx.params.id}{" "}
                <span data-testid="cik-modal-run">{++runs}</span>
              </div>
            ),
            { when: ({ from }) => from.url.pathname === INDEX },
          ),
        ],
      ),
    ]),
  ],
);
