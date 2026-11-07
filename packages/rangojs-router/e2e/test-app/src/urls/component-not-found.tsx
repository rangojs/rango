import { notFound, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A component that throws notFound() while React renders it.
//
// It is not a handler's throw, so catchSegmentError never sees it: React
// reports it to the Flight onError and the router's root boundary would render
// it as an error page. The render answers it instead (rsc/render-pipeline.ts):
// the route renders again with the notFoundBoundary() below, as a notFound()
// from the route's handler would, with a 404.

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
  ({ path, layout, errorBoundary, notFoundBoundary }) => [
    layout(
      () => (
        <main data-testid="cnf-shell">
          <Outlet />
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
            </div>
          ),
          { name: "index" },
        ),
        path("/throw", () => <ThrowSync />, { name: "throw" }),
        path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
      ],
    ),
  ],
);
