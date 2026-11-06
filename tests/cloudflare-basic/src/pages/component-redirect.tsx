import { loading, redirect, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A component that throws redirect() while React renders it.
//
// It is not a handler's return, so React reports it to the Flight onError and
// the page's boundaries would render it as an error. The render answers the
// redirect instead (rsc/render-pipeline.ts), on a document request and on a
// client navigation alike. The errorBoundary() below is what a real app
// declares; it does not catch a render-time throw (only a handler's or a
// loader's), so the router's root boundary is the one the error page would
// come from.

function ThrowSync(): React.ReactNode {
  throw redirect("/component-redirect/target", 302);
}

// Suspends on a macrotask, not a microtask: a document's shell has to await the
// segment for the redirect to be answered, and a microtask await would let a
// racy design pass.
async function ThrowAsync(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw redirect("/component-redirect/target", 302);
}

function ComponentRedirectBoundary({ error }: { error: Error }) {
  return <p data-testid="cr-boundary">boundary rendered: {error.message}</p>;
}

export const componentRedirectPatterns = urls(
  ({ path, layout, errorBoundary }) => [
    layout(
      () => (
        <main data-testid="cr-shell">
          <Outlet />
        </main>
      ),
      () => [
        errorBoundary(ComponentRedirectBoundary),
        path(
          "/",
          () => (
            <div data-testid="cr-index">
              <Link to="/component-redirect/throw" data-testid="cr-link">
                go sync
              </Link>
              <Link
                to="/component-redirect/throw-async"
                data-testid="cr-link-async"
              >
                go async
              </Link>
              <Link
                to="/component-redirect/throw-loading"
                data-testid="cr-link-loading"
              >
                go sync loading
              </Link>
            </div>
          ),
          { name: "index" },
        ),
        path("/throw", () => <ThrowSync />, { name: "throw" }),
        path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
        path(
          "/throw-loading",
          () => <ThrowSync />,
          { name: "throwLoading" },
          () => [loading(<p data-testid="cr-loading">loading</p>)],
        ),
        path("/target", () => <div data-testid="cr-target">arrived</div>, {
          name: "target",
        }),
      ],
    ),
  ],
);
