import { urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  LoaderRemountNav,
  LoaderRemountReader,
} from "./loader-remount-refresh.client.js";
import { LoaderRemountLoader } from "./loader-remount-refresh.loaders.js";

/** The loader's value rendered by the server, beside the client reader. */
async function LoaderRemountPage(ctx: HandlerContext) {
  const data = await ctx.use(LoaderRemountLoader);
  return (
    <section data-testid="lr-page">
      <span data-testid="lr-marker">{`${data.page}:${data.run}`}</span>
      <LoaderRemountReader />
    </section>
  );
}

function LoaderRemountLayout() {
  return (
    <div data-testid="lr-layout">
      <LoaderRemountNav base="/loader-remount" />
      <Outlet />
    </div>
  );
}

/**
 * Cloudflare-basic mirror of the router e2e app's /key-refresh-remount/*
 * fixture (urls/key-refresh.tsx): a refreshed registered reader across
 * navigations (tests/shared-e2e/src/loader-remount-refresh-scenario.ts).
 * Pages a and b register the loader, none does not, vt registers it under
 * transition(). The pages and their loader revalidate on every navigation:
 * a new visit then brings new route data instead of the client's cached
 * segments, and the marker re-renders in the response that re-runs the
 * loader (a search change alone re-runs only the loader).
 */
export const loaderRemountRefreshPatterns = urls(
  ({ path, layout, loader, revalidate, transition }) => [
    layout(LoaderRemountLayout, () => [
      path(
        "/loader-remount/a",
        LoaderRemountPage,
        { name: "loaderRemountA" },
        () => [
          loader(LoaderRemountLoader, () => [revalidate(() => true)]),
          revalidate(() => true),
        ],
      ),
      path(
        "/loader-remount/b",
        LoaderRemountPage,
        { name: "loaderRemountB" },
        () => [
          loader(LoaderRemountLoader, () => [revalidate(() => true)]),
          revalidate(() => true),
        ],
      ),
      path("/loader-remount/none", () => <p data-testid="lr-none">none</p>, {
        name: "loaderRemountNone",
      }),
      path(
        "/loader-remount/vt",
        LoaderRemountPage,
        { name: "loaderRemountVt" },
        () => [
          loader(LoaderRemountLoader, () => [revalidate(() => true)]),
          revalidate(() => true),
          transition(),
        ],
      ),
    ]),
  ],
);
