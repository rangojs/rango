import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  LateHistoryNoteLoader,
  LateHistorySlowLoader,
} from "./late-history.defs.js";
import {
  LateHistoryNotesReader,
  LateHistorySlowValue,
} from "./late-history.client.js";

// A late handle push, then a navigation while the hydration window is still
// open (the slow loader streams), then Back: the restored entry keeps the push.
function LateHistoryLayout() {
  return (
    <div data-testid="lh-layout">
      <Link to="/late-history/other" data-testid="lh-link-other">
        Other page
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
    path("/late-history/other", () => <p data-testid="lh-other">Other</p>, {
      name: "lateHistoryOther",
    }),
  ]),
]);
