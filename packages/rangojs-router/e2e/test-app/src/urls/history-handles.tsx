import { Breadcrumbs, Meta, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  HistoryHandlesCrumbs,
  HistoryHandlesTick,
} from "./history-handles.client.js";
import { HistoryHandlesTickLoader } from "./history-handles.defs.js";

// A link to a page the history cache holds merges its response's handles onto
// that page's own pushes. Section > A, and Section > B layout > B, whose
// loader reruns on every visit: the second link to B re-renders the loader
// only, and B's layout crumb, page crumb and title come from its entry. The
// section re-renders on a navigation to A only and shows its run in its crumb,
// so on the second B its crumb must be the run of the section it shows, the
// one from the page on screen. Links do not prefetch, so each click is
// answered by the history cache path.
let sectionRuns = 0;
function HistoryHandlesSection(ctx: any) {
  sectionRuns += 1;
  const runs = sectionRuns;
  ctx.use(Breadcrumbs)({ label: `History ${runs}`, href: "/history-handles" });
  return (
    <section data-testid="hch-section">
      <p data-testid="hch-section-runs">{runs}</p>
      <HistoryHandlesCrumbs />
      <Outlet />
    </section>
  );
}

function HistoryHandlesBLayout(ctx: any) {
  ctx.use(Breadcrumbs)({
    label: "B section",
    href: "/history-handles/b-section",
  });
  return <Outlet />;
}

export const historyHandlesPatterns = urls(
  ({ layout, path, loader, revalidate }) => [
    layout(HistoryHandlesSection, () => [
      revalidate(({ nextUrl }) => nextUrl.pathname === "/history-handles/a"),
      path(
        "/history-handles/a",
        (ctx) => {
          ctx.use(Breadcrumbs)({ label: "A", href: "/history-handles/a" });
          ctx.use(Meta)({ title: "History handles A" });
          return (
            <div data-testid="hch-a">
              <Link
                to="/history-handles/b"
                prefetch="none"
                data-testid="hch-to-b"
              >
                To B
              </Link>
            </div>
          );
        },
        { name: "historyHandlesA" },
      ),
      layout(HistoryHandlesBLayout, () => [
        path(
          "/history-handles/b",
          (ctx) => {
            ctx.use(Breadcrumbs)({ label: "B", href: "/history-handles/b" });
            ctx.use(Meta)({ title: "History handles B" });
            return (
              <div data-testid="hch-b">
                <HistoryHandlesTick />
                <Link
                  to="/history-handles/a"
                  prefetch="none"
                  data-testid="hch-to-a"
                >
                  To A
                </Link>
              </div>
            );
          },
          { name: "historyHandlesB" },
          () => [
            loader(HistoryHandlesTickLoader, () => [revalidate(() => true)]),
          ],
        ),
      ]),
    ]),
  ],
);
