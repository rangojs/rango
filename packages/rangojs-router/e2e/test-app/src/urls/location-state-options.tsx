import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { ServerPageStamp } from "../location-states.js";
import {
  AppVersionPanel,
  LoadMoreList,
  SharedCarriedCount,
} from "../components/LocationStateOptions.js";
import { LoadMoreLoader } from "./location-state.loader.js";

function OptionsShell() {
  return (
    <div>
      <SharedCarriedCount />
      <Outlet />
    </div>
  );
}

/**
 * The location-state fixtures that share a layout, included by
 * location-state.tsx at its own prefix. The layout's reader stays mounted
 * across a navigation between the two (#1029).
 */
export const locationStateOptionsPatterns = urls(({ path, loader, layout }) => [
  layout(OptionsShell, () => [
    // #994 clearOnReload, #1029, #1030: a "load more" list. LoadMoreLoader
    // loads the page the URL names; the earlier pages ride along as location
    // state on the Link. The handler sets state of its own on every request,
    // document loads included.
    path(
      "/load-more",
      (ctx) => {
        const page = Number(ctx.searchParams.get("page") ?? "1");
        ctx.setLocationState(ServerPageStamp({ page }));
        return <LoadMoreList basePath="/location-state/load-more" />;
      },
      { name: "loadMore" },
      () => [loader(LoadMoreLoader)],
    ),

    // #994 app version: readers of a typed slot and of plain state.
    path(
      "/app-version",
      (ctx) => (
        <AppVersionPanel
          basePath="/location-state/app-version"
          step={ctx.searchParams.get("step") ?? "start"}
        />
      ),
      { name: "appVersion" },
    ),
  ]),
]);
