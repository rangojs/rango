import {
  createLoader,
  urls,
  type Middleware,
  type Revalidate,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { NotReusedNoStoreRefresh } from "./not-reused-no-store.client.js";

// The four partials nothing may reuse, under a route that sends
// `private, no-store` (/private, as a signed-in app's middleware does) and
// one that sends nothing (/public). Each area's layout keeps itself by a
// revalidate() that reads the source page's URL, so a hover prefetch from a
// page under it is scoped to that page; `deferring` defers its loader in a
// prefetch, and the click that adopts it sends a fill; the refresh button
// sends a stale partial.
// Body: tests/shared-e2e/src/not-reused-no-store-scenario.ts.

const signedIn: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "private, no-store");
  await next();
};

const keepBySource: Revalidate = ({ currentUrl, defaultShouldRevalidate }) =>
  currentUrl.searchParams.has("refresh") ? true : defaultShouldRevalidate;

export const NotReusedNoStoreRatings = createLoader(async () => ({ stars: 4 }));

function Shell({ area }: { area: string }) {
  const base = `/not-reused-no-store/${area}`;
  return (
    <section>
      <Link to={`${base}/b`} prefetch="hover" data-testid="nrns-to-b">
        B
      </Link>
      <Link
        to={`${base}/deferring`}
        prefetch="hover"
        data-testid="nrns-to-deferring"
      >
        Deferring
      </Link>
      <NotReusedNoStoreRefresh />
      <Outlet />
    </section>
  );
}

const page = (area: string, name: string) => () => (
  <p data-testid="nrns-page">{`${area}:${name}`}</p>
);

export const notReusedNoStorePatterns = urls(
  ({ layout, path, loader, middleware, revalidate }) => [
    layout(
      () => <Shell area="private" />,
      () => [
        middleware(signedIn),
        revalidate(keepBySource),
        path("/private/a", page("private", "a")),
        path("/private/b", page("private", "b")),
        path("/private/deferring", page("private", "deferring"), () => [
          loader(NotReusedNoStoreRatings, { prefetch: false }),
        ]),
      ],
    ),
    layout(
      () => <Shell area="public" />,
      () => [
        revalidate(keepBySource),
        path("/public/a", page("public", "a")),
        path("/public/b", page("public", "b")),
        path("/public/deferring", page("public", "deferring"), () => [
          loader(NotReusedNoStoreRatings, { prefetch: false }),
        ]),
      ],
    ),
  ],
);
