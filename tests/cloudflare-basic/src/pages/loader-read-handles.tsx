import { Breadcrumbs, urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  LoaderReadHandlesHead,
  LoaderReadHandlesReader,
} from "./loader-read-handles.client.js";
import { LoaderReadHandlesChat } from "./loader-read-handles.loaders.js";

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
export const loaderReadHandlesPatterns = urls(({ path, layout, loader }) => [
  layout(LoaderReadHandlesLayout, () => [
    path(
      "/loader-read-handles/chat",
      () => <LoaderReadHandlesReader />,
      { name: "loaderReadHandlesChat" },
      () => [loader(LoaderReadHandlesChat)],
    ),
  ]),
]);
