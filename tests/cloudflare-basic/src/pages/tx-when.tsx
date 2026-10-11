import { urls, createLoader, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { TxIdleValue } from "../components/TxIdleValue.js";
import { txSrcWhen } from "../components/transition-when.js";
import { TxWhenState } from "../location-states.js";

/**
 * Cloudflare-basic mirror of the router e2e app's transition({ when })
 * fixtures (conditional-transition), per the repo's both-apps e2e mandate.
 * `when` is a browser predicate: it decides each navigation at its first
 * presentation from { kind, from, to, isAction }.
 *
 * /tx-when/:hold/:n declares its predicate inline; the build hoists it into a
 * client module. A same-route :n change (a -> b) re-suspends the existing
 * boundary: held (hold=1) keeps the previous content with no tx-when-loading
 * flash; gated off (hold=0) re-streams the skeleton.
 */
async function TxWhenContent({ hold, n }: { hold: string; n: string }) {
  // Slow enough that the loading() skeleton is observable when NOT held.
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-when-content">
      <span data-testid="tx-when-n">{n}</span>
      <Link
        to={`/tx-when/${hold}/a`}
        data-testid="tx-when-to-a"
        prefetch="none"
      >
        a
      </Link>
      <Link
        to={`/tx-when/${hold}/b`}
        data-testid="tx-when-to-b"
        prefetch="none"
      >
        b
      </Link>
    </div>
  );
}

const TxWhenHandler: Handler<"/tx-when/:hold/:n"> = (ctx) => (
  <TxWhenContent hold={ctx.params.hold} n={ctx.params.n} />
);

/**
 * Source-based gate (txSrcWhen, imported from a "use client" module): hold
 * unless the location being LEFT is n=b, or the destination was pushed with
 * TxWhenState { animate: false }. `<Link transition={false}>` gates one
 * navigation off without calling the predicate.
 */
async function TxSrcContent({ n }: { n: string }) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-src-content">
      <span data-testid="tx-src-n">{n}</span>
      <Link to="/tx-src/a" data-testid="tx-src-to-a" prefetch="none">
        a
      </Link>
      <Link to="/tx-src/b" data-testid="tx-src-to-b" prefetch="none">
        b
      </Link>
      <Link
        to="/tx-src/f"
        state={[TxWhenState({ animate: false })]}
        data-testid="tx-src-to-f-no-animate"
        prefetch="none"
      >
        f (animate: false)
      </Link>
      <Link
        to="/tx-src/g"
        transition={false}
        data-testid="tx-src-to-g-no-transition"
        prefetch="none"
      >
        g (transition: false)
      </Link>
    </div>
  );
}

const TxSrcHandler: Handler<"/tx-src/:n"> = (ctx) => (
  <TxSrcContent n={ctx.params.n} />
);

/**
 * /tx-idle/*: loading() with loaders of 100 and 400 ms (#1078). The routes
 * differ only in transition(): default, an always-false `when`, and
 * viewTransition: false.
 */
const idleDelay =
  (ms: number): (() => Promise<{ delay: number }>) =>
  async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { delay: ms };
  };
export const TxIdleFastLoader = createLoader(idleDelay(100));
export const TxIdleSlowLoader = createLoader(idleDelay(400));

function TxIdleShell() {
  return (
    <div data-testid="tx-idle-shell">
      {(["default", "when", "off"] as const).map((variant) => (
        <Link
          key={variant}
          to={`/tx-idle/${variant}`}
          data-testid={`tx-idle-to-${variant}`}
          prefetch="none"
        >
          {variant}
        </Link>
      ))}
      <Outlet />
    </div>
  );
}

function TxIdlePage() {
  return (
    <div data-testid="tx-idle-page">
      <TxIdleValue loader={TxIdleFastLoader} testId="tx-idle-fast" />
      <TxIdleValue loader={TxIdleSlowLoader} testId="tx-idle-slow" />
    </div>
  );
}

export const txWhenPatterns = urls(
  ({ path, layout, loader, loading, transition }) => [
    path("/tx-when/:hold/:n", TxWhenHandler, { name: "txWhen" }, () => [
      transition({ when: ({ to }) => to.params.hold === "1" }),
      loading(<div data-testid="tx-when-loading">tx-when-loading</div>),
    ]),
    path("/tx-src/:n", TxSrcHandler, { name: "txSrc" }, () => [
      transition({ when: txSrcWhen }),
      loading(<div data-testid="tx-src-loading">tx-src-loading</div>),
    ]),
    layout(TxIdleShell, () => [
      path("/tx-idle", () => <div data-testid="tx-idle-index">tx-idle</div>, {
        name: "txIdleIndex",
      }),
      path("/tx-idle/default", TxIdlePage, { name: "txIdleDefault" }, () => [
        loader(TxIdleFastLoader),
        loader(TxIdleSlowLoader),
        loading(<div data-testid="tx-idle-loading">tx-idle-loading</div>),
        transition(),
      ]),
      path("/tx-idle/when", TxIdlePage, { name: "txIdleWhen" }, () => [
        loader(TxIdleFastLoader),
        loader(TxIdleSlowLoader),
        loading(<div data-testid="tx-idle-loading">tx-idle-loading</div>),
        transition({ when: () => false }),
      ]),
      path("/tx-idle/off", TxIdlePage, { name: "txIdleOff" }, () => [
        loader(TxIdleFastLoader),
        loader(TxIdleSlowLoader),
        loading(<div data-testid="tx-idle-loading">tx-idle-loading</div>),
        transition({ viewTransition: false }),
      ]),
    ]),
  ],
);
