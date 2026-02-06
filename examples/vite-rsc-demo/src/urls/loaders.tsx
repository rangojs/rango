import { urls } from "@rangojs/router";
import {
  LoadersDemoLayout,
  LoadersIndexPage,
  LoadersStatsPage,
} from "../pages/loaders-demo.js";
import { UsersLoader } from "../handlers/loaders-demo/loaders.js";

export const loadersPatterns = urls(({ path, layout, loader, revalidate }) => [
  layout(<LoadersDemoLayout />, () => [
    // Global loader for the demo - provides users data
    loader(UsersLoader, () => [
      revalidate(({ actionId, stale, defaultShouldRevalidate }) => {
        const isUserAction = actionId?.includes("loaders-demo/actions");
        console.log("[Loaders] Revalidation check", { actionId, isUserAction });
        return isUserAction ?? stale ?? defaultShouldRevalidate;
      }),
    ]),

    path("/", LoadersIndexPage, { name: "index" }),
    path("/stats", LoadersStatsPage, { name: "stats" }),
  ]),
]);
