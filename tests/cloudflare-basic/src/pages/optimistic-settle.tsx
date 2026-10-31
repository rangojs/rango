import { createLoader, redirect, urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  OptimisticSettlePage,
  OptimisticSettleShell,
} from "../components/OptimisticSettle.js";

// Cloudflare-basic mirror of the router e2e app's /opt-settle/* fixture
// (urls/optimistic-settle.tsx), per the repo's both-apps e2e mandate.
//
// Optimistic hook values settle in the page's commit and never take its
// transition types (e2e optimistic-settle.test.ts, scenario in
// tests/shared-e2e/src/optimistic-settle-scenario.ts). Every request waits
// OS_SERVER_DELAY first; a page's loader then takes OS_PAGE_WAIT, read on the
// client with useLoader(), so a navigation's commit is handed to React long
// before its page can show.
// - /opt-settle/vt/:id: transition(), the router's <ViewTransition>.
// - /opt-settle/none/:id: no transition(); loading() shows a skeleton.
// - /opt-settle/<variant>/r: a server redirect to /opt-settle/<variant>/4.
// - /opt-settle/vt/f: a handler that throws, caught by the route's
//   errorBoundary().

const OS_SERVER_DELAY = 400;
const OS_PAGE_WAIT = 1500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function osServerDelay(_ctx: unknown, next: () => Promise<Response>) {
  await wait(OS_SERVER_DELAY);
  return next();
}

/** The page's data: it streams OS_PAGE_WAIT after the response starts. */
export const OptimisticSettleLoader = createLoader(async (ctx) => {
  await wait(OS_PAGE_WAIT);
  return ctx.params.id!;
});

function OsPage() {
  return <OptimisticSettlePage loader={OptimisticSettleLoader} />;
}

function OsFailPage(): never {
  throw new Error("opt-settle: the page failed");
}

export const optimisticSettlePatterns = urls(
  ({
    path,
    layout,
    loader,
    loading,
    middleware,
    transition,
    errorBoundary,
  }) => [
    layout(
      <OptimisticSettleShell base="/opt-settle/vt">
        <Outlet />
      </OptimisticSettleShell>,
      () => [
        middleware(osServerDelay),
        path("/opt-settle/vt/r", () => redirect("/opt-settle/vt/4", 302), {
          name: "optSettleVtRedirect",
        }),
        path(
          "/opt-settle/vt/f",
          OsFailPage,
          { name: "optSettleVtFail" },
          () => [
            errorBoundary(() => <p data-testid="opt-settle-error">failed</p>),
            transition(),
          ],
        ),
        path("/opt-settle/vt/:id", OsPage, { name: "optSettleVt" }, () => [
          loader(OptimisticSettleLoader),
          transition(),
        ]),
      ],
    ),
    layout(
      <OptimisticSettleShell base="/opt-settle/none">
        <Outlet />
      </OptimisticSettleShell>,
      () => [
        middleware(osServerDelay),
        path("/opt-settle/none/r", () => redirect("/opt-settle/none/4", 302), {
          name: "optSettleNoneRedirect",
        }),
        path("/opt-settle/none/:id", OsPage, { name: "optSettleNone" }, () => [
          loader(OptimisticSettleLoader),
          loading(<p data-testid="opt-settle-skeleton">loading</p>),
        ]),
      ],
    ),
  ],
);
