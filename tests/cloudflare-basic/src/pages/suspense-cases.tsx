import { Suspense } from "react";
import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  ScALoader,
  ScBLoader,
  ScItemLoader,
  ScLiveLoader,
  ScOwnALoader,
  ScOwnBLoader,
  ScShellLoader,
  ScSlowLoader,
} from "./suspense-cases.loaders.js";
import {
  ScAValue,
  ScBValue,
  ScControls,
  ScInstance,
  ScItemValue,
  ScLive,
  ScNavState,
  ScNotesView,
  ScOwnAValue,
  ScOwnBValue,
  ScShellValue,
  ScSlowValue,
} from "./suspense-cases.client.js";
import { ScNotes } from "./suspense-cases.handle.js";
import { scWhen } from "./suspense-cases.when.js";

/**
 * Fixtures for the suspense contract (docs/internal/suspense-contract.md),
 * the same file in the router test-app and in cloudflare-basic. Body:
 * tests/shared-e2e/src/suspense-cases.ts.
 *
 * The hub (/sc) sits outside every layout, so entering a group mounts its
 * layout fresh. Every link is `prefetch="none"` unless its test id ends in
 * `-pf` (hover).
 *
 *  - /sc/plain/:id, /sc/slow, /sc/two, /sc/list, /sc/detail/:id: one shell
 *    layout with loading() and a loader; /sc/detail/:id opens as the
 *    @scModal intercept from /sc/list
 *  - /sc/tx/:id: the same shape inside a transition() block
 *  - /sc/when/:n: transition({ when: scWhen })
 *  - /sc/above/:id: the route's loader is read by the layout above it
 *  - /sc/slot/:id: a parallel slot with no loading(), slow for id "slow"
 *  - /sc/own/:id: a route with loading() whose two loaders are each read
 *    behind a boundary of their own
 *  - /sc/live: what updates in place: a handle with one push made after
 *    the page committed, and a loader its reader refetches
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function To({
  to,
  id,
  prefetch = "none",
}: {
  to: string;
  id: string;
  prefetch?: "none" | "hover";
}) {
  return (
    <Link to={to} data-testid={id} prefetch={prefetch}>
      {id}
    </Link>
  );
}

const ScHub: Handler = () => (
  <div data-testid="sc-hub">
    <To to="/sc/plain/1" id="sc-hub-plain-1" />
    <To to="/sc/plain/1" id="sc-hub-plain-1-pf" prefetch="hover" />
    <To to="/sc/slow" id="sc-hub-slow" />
    <To to="/sc/two" id="sc-hub-two" />
    <To to="/sc/list" id="sc-hub-list" />
    <To to="/sc/tx/1" id="sc-hub-tx-1" />
    <To to="/sc/when/a" id="sc-hub-when-a" />
    <To to="/sc/above/1" id="sc-hub-above-1" />
    <To to="/sc/slot/fast" id="sc-hub-slot-fast" />
    <To to="/sc/live" id="sc-hub-live" />
    <To to="/sc/own/1" id="sc-hub-own-1" />
    <To to="/client-urls-slow/b/first" id="sc-hub-cus-b" />
  </div>
);

const ScShell: Handler = () => (
  <div data-testid="sc-shell">
    <ScInstance id="shell" />
    <ScShellValue />
    <ScNavState />
    <ScControls />
    <To to="/sc/plain/1" id="sc-to-plain-1" />
    <To to="/sc/plain/2" id="sc-to-plain-2" />
    <To to="/sc/slow" id="sc-to-slow" />
    <To to="/sc/two" id="sc-to-two" />
    <To to="/sc/list" id="sc-to-list" />
    <To to="/sc/detail/1" id="sc-to-detail-1" />
    <Outlet />
    <ParallelOutlet name="@scModal" />
  </div>
);

const ScPlain: Handler<"/sc/plain/:id"> = (ctx) => (
  <div data-testid="sc-plain">
    <span data-testid="sc-plain-id">{ctx.params.id}</span>
    <ScInstance id="route" />
    <ScItemValue testId="sc-item-value" />
  </div>
);

const ScLivePage: Handler = (ctx) => {
  ctx.use(ScNotes)("with-the-page");
  // Resolves after the navigation committed: the reader updates in place.
  ctx.use(ScNotes)(wait(600).then(() => "late"));
  return (
    <div data-testid="sc-live">
      <ScInstance id="live" />
      <ScNotesView />
      <Suspense fallback={<span data-testid="sc-live-fallback">live</span>}>
        <ScLive />
      </Suspense>
    </div>
  );
};

const ScOwn: Handler<"/sc/own/:id"> = (ctx) => (
  <div data-testid="sc-own">
    <span data-testid="sc-own-id">{ctx.params.id}</span>
    <ScInstance id="own" />
    <Suspense fallback={<span data-testid="sc-own-a-fallback">a</span>}>
      <ScOwnAValue />
    </Suspense>
    <Suspense fallback={<span data-testid="sc-own-b-fallback">b</span>}>
      <ScOwnBValue />
    </Suspense>
  </div>
);

const ScSlow: Handler = () => (
  <div data-testid="sc-slow">
    <ScSlowValue />
  </div>
);

const ScTwo: Handler = () => (
  <div data-testid="sc-two">
    <ScInstance id="two" />
    <ScAValue />
    <ScBValue />
  </div>
);

const ScList: Handler = () => (
  <div data-testid="sc-list">
    <ScInstance id="list" />
  </div>
);

const ScDetail: Handler<"/sc/detail/:id"> = (ctx) => (
  <div data-testid="sc-detail">{ctx.params.id}</div>
);

const ScTxShell: Handler = () => (
  <div data-testid="sc-tx-shell">
    <ScInstance id="tx-shell" />
    <ScShellValue />
    <To to="/sc/tx/1" id="sc-to-tx-1" />
    <To to="/sc/tx/2" id="sc-to-tx-2" />
    <Outlet />
  </div>
);

const ScTx: Handler<"/sc/tx/:id"> = (ctx) => (
  <div data-testid="sc-tx">
    <span data-testid="sc-tx-id">{ctx.params.id}</span>
    <ScInstance id="tx-route" />
    <ScItemValue testId="sc-tx-value" />
  </div>
);

const ScWhen: Handler<"/sc/when/:n"> = (ctx) => (
  <div data-testid="sc-when">
    <span data-testid="sc-when-n">{ctx.params.n}</span>
    <ScInstance id="when" />
    <ScItemValue testId="sc-when-value" />
    <ScControls />
    <To to="/sc/when/a" id="sc-to-when-a" />
    <To to="/sc/when/b" id="sc-to-when-b" />
    <To to="/sc/when/c" id="sc-to-when-c" />
  </div>
);

// The loader belongs to the route below: the reader needs a boundary of its
// own, the layout has no loading().
const ScAbove: Handler = () => (
  <div data-testid="sc-above-layout">
    <ScInstance id="above" />
    <Suspense fallback={<span data-testid="sc-above-fallback">…</span>}>
      <ScItemValue testId="sc-above-value" />
    </Suspense>
    <ScControls />
    <To to="/sc/above/1" id="sc-to-above-1" />
    <To to="/sc/above/2" id="sc-to-above-2" />
    <Outlet />
  </div>
);

const ScAbovePage: Handler<"/sc/above/:id"> = (ctx) => (
  <div data-testid="sc-above-page">{ctx.params.id}</div>
);

const ScSlotLayout: Handler = () => (
  <div data-testid="sc-slot-layout">
    <To to="/sc/slot/fast" id="sc-to-slot-fast" />
    <To to="/sc/slot/slow" id="sc-to-slot-slow" />
    <Outlet />
    <ParallelOutlet name="@scSide" />
  </div>
);

// Slow for id "slow": the payload then carries the slot's component as a
// promise, and as a node otherwise (client.tsx renderSlotContent).
const ScSide: Handler = async (ctx) => {
  const id = (ctx.params as { id?: string }).id;
  if (id === "slow") await wait(300);
  return (
    <div data-testid="sc-side">
      <span data-testid="sc-side-id">{id}</span>
      <ScInstance id="side" />
    </div>
  );
};

const ScSlotPage: Handler<"/sc/slot/:id"> = (ctx) => (
  <div data-testid="sc-slot-page">{ctx.params.id}</div>
);

export const suspenseCasesPatterns = urls(
  ({
    layout,
    path,
    loader,
    loading,
    parallel,
    intercept,
    transition,
    revalidate,
  }) => [
    path("/sc", ScHub, { name: "hub" }),
    path("/sc/own/:id", ScOwn, { name: "own" }, () => [
      loader(ScOwnALoader),
      loader(ScOwnBLoader),
      loading(<div data-testid="sc-own-fallback">sc-own-loading</div>),
    ]),
    path("/sc/live", ScLivePage, { name: "live" }, () => [
      loader(ScLiveLoader),
    ]),

    layout(ScShell, () => [
      loader(ScShellLoader),
      loading(<div data-testid="sc-shell-fallback">sc-shell-loading</div>),
      path("/sc/plain/:id", ScPlain, { name: "plain" }, () => [
        loader(ScItemLoader),
        loading(<div data-testid="sc-item-fallback">sc-item-loading</div>),
      ]),
      path("/sc/slow", ScSlow, { name: "slow" }, () => [
        loader(ScSlowLoader),
        loading(<div data-testid="sc-slow-fallback">sc-slow-loading</div>),
      ]),
      path("/sc/two", ScTwo, { name: "two" }, () => [
        loader(ScALoader),
        loader(ScBLoader, () => [revalidate(() => false)]),
        loading(<div data-testid="sc-two-fallback">sc-two-loading</div>),
      ]),
      path("/sc/list", ScList, { name: "list" }),
      path("/sc/detail/:id", ScDetail, { name: "detail" }),
      intercept(
        "@scModal",
        ".detail",
        (ctx) => (
          <div role="dialog" data-testid="sc-modal">
            {ctx.params.id}
          </div>
        ),
        { when: ({ from }) => from.url.pathname === "/sc/list" },
      ),
    ]),

    transition({}, () => [
      layout(ScTxShell, () => [
        loader(ScShellLoader),
        loading(
          <div data-testid="sc-tx-shell-fallback">sc-tx-shell-loading</div>,
        ),
        path("/sc/tx/:id", ScTx, { name: "tx" }, () => [
          loader(ScItemLoader),
          loading(<div data-testid="sc-tx-fallback">sc-tx-loading</div>),
        ]),
      ]),
    ]),

    path("/sc/when/:n", ScWhen, { name: "when" }, () => [
      transition({ when: scWhen }),
      loader(ScItemLoader),
      loading(<div data-testid="sc-when-fallback">sc-when-loading</div>),
    ]),

    layout(ScAbove, () => [
      path("/sc/above/:id", ScAbovePage, { name: "above" }, () => [
        loader(ScItemLoader),
      ]),
    ]),

    layout(ScSlotLayout, () => [
      parallel({ "@scSide": ScSide }, () => [revalidate(() => true)]),
      path("/sc/slot/:id", ScSlotPage, { name: "slot" }),
    ]),
  ],
);
