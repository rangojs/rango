import { urls, redirect } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A server component that throws redirect() while React renders it, reached by
// a client navigation.
//
// The Flight error row's digest names the target (rsc/render-pipeline.ts), and
// the browser follows it: before the navigation commits when the segment's
// component is the one that threw (segment-system.tsx renderSegments), from
// the page segment's router boundary when React meets it only while it
// renders (nested in the handler's element, behind loading(), or thrown by a
// handler that streams under loading()). The layout's <input> keeps what the
// test typed only if the layout never unmounted.

function ThrowSync(): React.ReactNode {
  throw redirect("/component-redirect-nav/target", 302);
}

async function ThrowAsync(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  throw redirect("/component-redirect-nav/target", 302);
}

function CrnBoundary({ error }: { error: Error }) {
  return <p data-testid="crn-boundary">boundary rendered: {error.message}</p>;
}

export const componentRedirectNavPatterns = urls(
  ({ path, layout, loading, errorBoundary }) => [
    layout(
      () => (
        <main data-testid="crn-shell">
          <input data-testid="crn-input" aria-label="kept while mounted" />
          <Outlet />
        </main>
      ),
      () => [
        errorBoundary(CrnBoundary),
        path(
          "/",
          () => (
            <nav data-testid="crn-index">
              <Link
                to="/component-redirect-nav/throw-async"
                data-testid="crn-link-async"
              >
                async
              </Link>
              <Link
                to="/component-redirect-nav/throw-sync"
                data-testid="crn-link-sync"
              >
                sync
              </Link>
              <Link
                to="/component-redirect-nav/throw-nested"
                data-testid="crn-link-nested"
              >
                nested
              </Link>
              <Link
                to="/component-redirect-nav/throw-loading"
                data-testid="crn-link-loading"
              >
                loading
              </Link>
              <Link
                to="/component-redirect-nav/handler-loading"
                data-testid="crn-link-handler-loading"
              >
                handler under loading()
              </Link>
            </nav>
          ),
          { name: "index" },
        ),
        path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
        path("/throw-sync", () => <ThrowSync />, { name: "throwSync" }),
        path(
          "/throw-nested",
          () => (
            <section>
              <ThrowAsync />
            </section>
          ),
          { name: "throwNested" },
        ),
        path(
          "/throw-loading",
          () => <ThrowAsync />,
          { name: "throwLoading" },
          () => [loading(<p data-testid="crn-loading">loading</p>)],
        ),
        // The handler itself, async under loading(): streamed, so its
        // redirect is a Flight error row too (handleHandlerResult rethrows it).
        path(
          "/handler-loading",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw redirect("/component-redirect-nav/target", 302);
          },
          { name: "handlerLoading" },
          () => [loading(<p data-testid="crn-loading">loading</p>)],
        ),
        path("/target", () => <p data-testid="crn-target">arrived</p>, {
          name: "target",
        }),
      ],
    ),
  ],
);
