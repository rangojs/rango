import { Breadcrumbs, urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  LoaderReadHandlesHead,
  LoaderReadHandlesReader,
  LoaderReadHandlesTallyBar,
} from "./loader-read-handles.client.js";
import {
  LoaderReadHandlesChat,
  LoaderReadHandlesLate,
  LoaderReadHandlesTally,
} from "./loader-read-handles.loaders.js";

function LoaderReadHandlesLayout(ctx: HandlerContext) {
  ctx.use(Breadcrumbs)({ label: "Chats", href: "/loader-read-handles" });
  return (
    <div>
      <LoaderReadHandlesHead />
      <Outlet />
    </div>
  );
}

/**
 * Cloudflare-basic mirror of the router e2e app's /loader-read-handles/chat
 * fixture (urls/loader-read-handles.tsx): a loader read on its own (a group
 * refresh, load()) applies the title and crumb its body pushes
 * (tests/shared-e2e/src/loader-read-handles-scenario.ts).
 */
export const loaderReadHandlesPatterns = urls(
  ({ path, layout, loader, revalidate }) => [
    layout(LoaderReadHandlesLayout, () => [
      path(
        "/loader-read-handles/chat",
        () => <LoaderReadHandlesReader />,
        { name: "loaderReadHandlesChat" },
        () => [loader(LoaderReadHandlesChat)],
      ),
      // The chat again, with a loader whose crumb arrives on the document's
      // late handle channel after a load() refreshed the chat.
      path(
        "/loader-read-handles/late",
        () => <LoaderReadHandlesReader />,
        { name: "loaderReadHandlesLate" },
        () => [loader(LoaderReadHandlesChat), loader(LoaderReadHandlesLate)],
      ),
      // The chat again, kept across an action (revalidate(false)) that re-runs
      // the tally beside it: a load() that lands while the action's update is
      // on its way is newer than the chat data that update carries.
      path(
        "/loader-read-handles/kept",
        () => (
          <>
            <LoaderReadHandlesReader />
            <LoaderReadHandlesTallyBar />
          </>
        ),
        { name: "loaderReadHandlesKept" },
        () => [
          loader(LoaderReadHandlesChat, () => [revalidate(false)]),
          loader(LoaderReadHandlesTally),
        ],
      ),
    ]),
  ],
);
