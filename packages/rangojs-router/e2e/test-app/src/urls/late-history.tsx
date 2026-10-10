import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  LateHistoryNoteLoader,
  LateHistoryNotes,
  LateHistorySlowLoader,
} from "./late-history.defs.js";
import {
  LateHistoryNotesReader,
  LateHistorySlowValue,
} from "./late-history.client.js";

// A late handle push, then a navigation while the hydration window is still
// open (the slow loader streams), then Back: the restored entry keeps the push.
// The other page pushes its own note; the shallow link changes the search
// params without a fetch.
function LateHistoryLayout() {
  return (
    <div data-testid="lh-layout">
      <Link to="/late-history/other" data-testid="lh-link-other">
        Other page
      </Link>
      <Link
        to="/late-history/page?shallow=1"
        revalidate={false}
        data-testid="lh-link-shallow"
      >
        Shallow
      </Link>
      <LateHistoryNotesReader />
      <Outlet />
    </div>
  );
}

export const lateHistoryPatterns = urls(({ layout, path, loader, loading }) => [
  layout(LateHistoryLayout, () => [
    path(
      "/late-history/page",
      () => <LateHistorySlowValue />,
      { name: "lateHistoryPage" },
      () => [
        loader(LateHistoryNoteLoader),
        loader(LateHistorySlowLoader),
        loading(<p data-testid="lh-loading">Loading</p>),
      ],
    ),
    path(
      "/late-history/other",
      (ctx) => {
        ctx.use(LateHistoryNotes)("other page note");
        return <p data-testid="lh-other">Other</p>;
      },
      { name: "lateHistoryOther" },
    ),
  ]),
]);
