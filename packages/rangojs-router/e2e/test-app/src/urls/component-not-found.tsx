import { notFound, urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

// A component that throws notFound() while React renders it.
//
// It is not a handler's throw, so catchSegmentError never sees it: React
// reports it to the Flight onError and the router's root boundary would render
// it as an error page. The render answers it instead (rsc/render-pipeline.ts):
// the page renders again with what a notFound() from the throwing segment's
// handler would render, with a 404. A route's, a layout's and a parallel
// slot's component render the notFoundBoundary() below in place of that
// segment's entry; an intercept's renders it in the slot.

function ThrowSync(): React.ReactNode {
  throw notFound("no such product");
}

async function ThrowAsync(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw notFound("no such product");
}

function ComponentNotFoundBoundary({ error }: { error: Error }) {
  return <p data-testid="cnf-error">error boundary: {error.message}</p>;
}

export const componentNotFoundPatterns = urls(
  ({ path, layout, parallel, intercept, errorBoundary, notFoundBoundary }) => [
    layout(
      () => (
        <main data-testid="cnf-shell">
          <Link
            to="/component-not-found/layout/ok"
            data-testid="cnf-layout-ok-link"
          >
            layout ok
          </Link>
          <Outlet />
          <ParallelOutlet name="@cnfModal" />
        </main>
      ),
      () => [
        errorBoundary(ComponentNotFoundBoundary),
        notFoundBoundary(({ notFound }) => (
          <p data-testid="cnf-not-found">not found: {notFound.message}</p>
        )),
        path(
          "/",
          () => (
            <div data-testid="cnf-index">
              <Link to="/component-not-found/throw" data-testid="cnf-link">
                go sync
              </Link>
              <Link
                to="/component-not-found/layout/missing"
                data-testid="cnf-layout-link"
              >
                go layout
              </Link>
              <Link to="/component-not-found/slot" data-testid="cnf-slot-link">
                go slot
              </Link>
              <Link
                to="/component-not-found/photo/1"
                data-testid="cnf-photo-link"
              >
                go photo
              </Link>
            </div>
          ),
          { name: "index" },
        ),
        path("/throw", () => <ThrowSync />, { name: "throw" }),
        path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
        // The layout's own component throws on /missing only: a navigation
        // from there to /ok must render the layout again, not keep the
        // fallback in its place.
        layout(
          (ctx) => (
            <section data-testid="cnf-layout">
              {ctx.url.pathname.endsWith("/missing") ? <ThrowSync /> : null}
              <Outlet />
            </section>
          ),
          () => [
            path(
              "/layout/missing",
              () => <p data-testid="cnf-layout-page">missing page</p>,
              { name: "layoutMissing" },
            ),
            path(
              "/layout/ok",
              () => <p data-testid="cnf-layout-page">ok page</p>,
              { name: "layoutOk" },
            ),
          ],
        ),
        layout(
          () => (
            <section data-testid="cnf-slot-owner">
              <ParallelOutlet name="@cnfSide" />
              <Outlet />
            </section>
          ),
          () => [
            parallel({ "@cnfSide": () => <ThrowSync /> }),
            path("/slot", () => <p data-testid="cnf-slot-page">slot page</p>, {
              name: "slot",
            }),
          ],
        ),
        path(
          "/photo/:id",
          (ctx) => <p data-testid="cnf-photo">photo {ctx.params.id}</p>,
          { name: "photo" },
        ),
        intercept("@cnfModal", ".photo", () => (
          <div data-testid="cnf-modal">
            <ThrowSync />
          </div>
        )),
      ],
    ),
  ],
);
