import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { CacheInterceptLayout } from "../components/layouts/index.js";
import { InterceptHeldCrumbs } from "./intercept-held.defs.js";
import { InterceptHeldCrumbsBar } from "./intercept-held.client.js";
import { CacheInterceptSharedLoader } from "./cache-intercept-crumbs.defs.js";

// e2e/cache.test.ts "cache-intercept-routes" (rango-t184). cache() covers the
// layout, so the second intercept navigation from the index is a HIT of the
// intercept: record. A loader the detail route and its intercept both declare
// pushes a crumb the layout renders: the HIT shows the crumbs the MISS shows.
export const cacheInterceptCrumbsPatterns = urls(
  ({ path, layout, intercept, cache, loader }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx) => {
          ctx.use(InterceptHeldCrumbs)("layout");
          return (
            <>
              <InterceptHeldCrumbsBar />
              <CacheInterceptLayout />
            </>
          );
        },
        () => [
          path(
            "/",
            (ctx) => {
              ctx.use(InterceptHeldCrumbs)("index");
              return (
                <div data-testid="cic-index">
                  <Link
                    to="/cache-intercept-crumbs/item/a"
                    prefetch="none"
                    data-testid="cic-link"
                  >
                    A
                  </Link>
                </div>
              );
            },
            { name: "index" },
          ),
          path(
            "/item/:id",
            (ctx) => {
              ctx.use(InterceptHeldCrumbs)(`page-${ctx.params.id}`);
              return <div data-testid="cic-detail">detail {ctx.params.id}</div>;
            },
            { name: "item" },
            () => [loader(CacheInterceptSharedLoader)],
          ),
          intercept(
            "@cacheModal",
            ".item",
            (ctx) => {
              ctx.use(InterceptHeldCrumbs)(`modal-${ctx.params.id}`);
              return <div data-testid="cic-modal">modal {ctx.params.id}</div>;
            },
            () => [loader(CacheInterceptSharedLoader)],
          ),
        ],
      ),
    ]),
  ],
);
