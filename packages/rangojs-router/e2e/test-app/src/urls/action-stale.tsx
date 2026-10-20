import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ActionStaleCartLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import { ActionStaleBar } from "./action-stale.client.js";
import { actionStaleState, wait } from "./action-stale.store.js";

// A layout cart count whose loader opts into `stale`, a layout loader on the
// default, a product page with the add-to-cart action, and a second page. The
// product page renders a prefetching link only with ?prefetch=render, so
// no other case has a prefetch to consume. Body:
// tests/shared-e2e/src/action-stale-navigation-scenario.ts.
function ActionStaleLayout() {
  return (
    <div data-testid="as-layout">
      <ActionStaleBar />
      <Outlet />
    </div>
  );
}

// Answers at once, so an action's response arrives before its revalidation's
// 300 ms cart loader, which its commit waits for.
const ActionStalePdp: Handler = (ctx) => {
  return (
    <div data-testid="as-pdp">
      <Link to="/action-stale/other" prefetch="none" data-testid="as-to-other">
        Other
      </Link>
      <Link
        to="/action-stale/other?delay=500"
        prefetch="none"
        data-testid="as-to-other-slow"
      >
        Other, slow
      </Link>
      <Link to="/action-stale/read" prefetch="none" data-testid="as-to-read">
        Read
      </Link>
      {ctx.searchParams.get("prefetch") === "render" && (
        <Link
          to="/action-stale/other"
          prefetch="render"
          data-testid="as-to-other-prefetched"
        >
          Other, prefetched
        </Link>
      )}
    </div>
  );
};

/** ?delay ms (default 300). */
const ActionStaleOther: Handler = async (ctx) => {
  await wait(Number(ctx.searchParams.get("delay") ?? 300));
  return (
    <div data-testid="as-other">
      <Link to="/action-stale/pdp" prefetch="none" data-testid="as-to-pdp">
        Product
      </Link>
      <Link to="/action-stale/slow" prefetch="none" data-testid="as-to-slow">
        Slow
      </Link>
    </div>
  );
};

// Answers after 900 ms: later than the 500 ms action and the 300 ms page
// before it.
const ActionStaleSlow: Handler = async () => {
  await wait(900);
  return <div data-testid="as-slow">Slow page</div>;
};

// Reads the cart as it starts and answers 1800 ms later: its read comes
// before the write an action makes at 800 ms, its commit after that action
// lands (dc-q78).
const ActionStaleRead: Handler = async () => {
  const { cart } = actionStaleState();
  await wait(1800);
  return <div data-testid="as-read">{`read:${cart}`}</div>;
};

export const actionStalePatterns = urls(
  ({ layout, path, loader, revalidate }) => [
    layout(ActionStaleLayout, () => [
      loader(ActionStaleCartLoader, () => [
        revalidate(
          ({ stale, defaultShouldRevalidate }) =>
            stale || defaultShouldRevalidate,
        ),
      ]),
      loader(ActionStalePlainLoader),
      path("/action-stale/pdp", ActionStalePdp),
      path("/action-stale/other", ActionStaleOther),
      path("/action-stale/slow", ActionStaleSlow),
      path("/action-stale/read", ActionStaleRead),
    ]),
  ],
);
