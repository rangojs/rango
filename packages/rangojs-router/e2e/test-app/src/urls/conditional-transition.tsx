import {
  urls,
  type Handler,
  type TransitionWhenContext,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { TxMountProbe } from "../components/TxMountProbe.js";
import { TxActionProbe, TxFailProbe } from "../components/TxActionProbe.js";
import {
  txActWhen,
  txHoldWhen,
  txKeepWhen,
  txSrcWhen,
} from "../components/transition-when.js";
import { TxWhenState } from "../location-states.js";

/**
 * Conditional transition: transition({ when }) gates the navigation's hold
 * and view transition. The predicates are "use client" exports
 * (components/transition-when.ts): the browser decides at the navigation's
 * first presentation; the server only carries them.
 *
 * The hold is observable on a SAME-route param nav (:n a -> b), which
 * re-suspends the existing boundary: when the predicate holds, the previous
 * content stays (no loading() skeleton); false makes the commit urgent and
 * the skeleton streams. prefetch="none" forces cold navigations unless a test
 * is about prefetch reuse.
 */

// Async server component, param-dependent so a same-route :n change
// re-suspends. Slow enough that the loading() skeleton is observable when NOT
// held.
async function TxWhenContent({ hold, n }: { hold: string; n: string }) {
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
 * Source-based gate (txSrcWhen): hold unless the location being LEFT is n=b,
 * or the destination was pushed with TxWhenState { animate: false }.
 * TxMountProbe tells a reconcile (clicks kept) from a remount (#995).
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
      <TxMountProbe />
      <TxActionProbe />
      {/* Prefetch reuse: c is render-prefetched from every /tx-src page (one
          shared entry); d/e are cold. */}
      <Link to="/tx-src/c" data-testid="tx-src-to-c-pf" prefetch="render">
        c (prefetched)
      </Link>
      <Link to="/tx-src/d" data-testid="tx-src-to-d" prefetch="none">
        d
      </Link>
      <Link to="/tx-src/e" data-testid="tx-src-to-e" prefetch="none">
        e
      </Link>
    </div>
  );
}

const TxSrcHandler: Handler<"/tx-src/:n"> = (ctx) => (
  <TxSrcContent n={ctx.params.n} />
);

/**
 * #989: the predicate is on a LAYOUT the sibling navigations keep (never
 * re-sent). A held commit animates the layout's <ViewTransition> around its
 * outlet (document.startViewTransition runs); a gated-off one is urgent and
 * does not.
 */
function TxKeepShell() {
  return (
    <div data-testid="tx-keep-shell">
      <Link to="/tx-keep/a" data-testid="tx-keep-to-a" prefetch="none">
        a
      </Link>
      <Link to="/tx-keep/b" data-testid="tx-keep-to-b" prefetch="none">
        b
      </Link>
      <Link to="/tx-keep/c" data-testid="tx-keep-to-c" prefetch="none">
        c
      </Link>
      <Outlet />
    </div>
  );
}

async function TxKeepPage({ n }: { n: string }) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <div data-testid="tx-keep-n">{n}</div>;
}

/**
 * Inline predicate (the build hoists it into a "use client" module): holds
 * unless the destination is n=b or was pushed with TxWhenState
 * { animate: false }. It reads TxWhenState, an import of this module that the
 * hoist re-emits, and logs to window.__txInlineLog.
 */
async function TxInlineContent({ n }: { n: string }) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-inline-content">
      <span data-testid="tx-inline-n">{n}</span>
      <Link to="/tx-inline/a" data-testid="tx-inline-to-a" prefetch="none">
        a
      </Link>
      <Link to="/tx-inline/b" data-testid="tx-inline-to-b" prefetch="none">
        b
      </Link>
      <Link to="/tx-inline/c" data-testid="tx-inline-to-c" prefetch="none">
        c
      </Link>
    </div>
  );
}

const TxInlineHandler: Handler<"/tx-inline/:n"> = (ctx) => (
  <TxInlineContent n={ctx.params.n} />
);

/** /tx-act/:n: a layout predicate logs the action commits, error lane included. */
function TxActShell() {
  return (
    <div data-testid="tx-act-shell">
      <Outlet />
    </div>
  );
}

const TxActHandler: Handler<"/tx-act/:n"> = (ctx) => (
  <div data-testid="tx-act-page">
    <span data-testid="tx-act-n">{ctx.params.n}</span>
    <TxActionProbe />
    <TxFailProbe />
  </div>
);

export const conditionalTransitionPatterns = urls(
  ({ path, layout, loading, transition, errorBoundary }) => [
    path("/tx-when/:hold/:n", TxWhenHandler, { name: "txWhen" }, () => [
      transition({ when: txHoldWhen }),
      loading(<div data-testid="tx-when-loading">tx-when-loading</div>),
    ]),
    path("/tx-src/:n", TxSrcHandler, { name: "txSrc" }, () => [
      transition({ when: txSrcWhen }),
      loading(<div data-testid="tx-src-loading">tx-src-loading</div>),
    ]),
    path("/tx-inline/:n", TxInlineHandler, { name: "txInline" }, () => [
      transition({
        when: (ctx: TransitionWhenContext) => {
          const result =
            ctx.to.params.n !== "b" &&
            TxWhenState.read(ctx.to)?.animate !== false;
          const w = window as unknown as { __txInlineLog?: string[] };
          (w.__txInlineLog ??= []).push(
            `${ctx.kind} ${ctx.from.url.pathname}->${ctx.to.url.pathname}:${result}`,
          );
          return result;
        },
      }),
      loading(<div data-testid="tx-inline-loading">tx-inline-loading</div>),
    ]),
    layout(TxKeepShell, () => [
      transition({ when: txKeepWhen }),
      path("/tx-keep/a", () => <TxKeepPage n="a" />, { name: "txKeepA" }),
      path("/tx-keep/b", () => <TxKeepPage n="b" />, { name: "txKeepB" }),
      path("/tx-keep/c", () => <TxKeepPage n="c" />, { name: "txKeepC" }),
    ]),
    layout(TxActShell, () => [
      transition({ when: txActWhen }),
      errorBoundary(() => <div data-testid="tx-act-error">tx-act-error</div>),
      path("/tx-act/:n", TxActHandler, { name: "txAct" }),
    ]),
  ],
);
