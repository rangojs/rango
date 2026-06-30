import {
  urls,
  Meta,
  Breadcrumbs,
  cookies,
  type Handler,
} from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Suspense } from "react";
import { ResolvedTrailBreadcrumbs } from "../components/TrailBreadcrumbs.js";

/**
 * Routes pinning the resolve-by-default deferred-handle navigation contract and
 * the history-cache poisoning fix (P1), exercised through CLIENT (soft) and full
 * (SSR) navigation.
 *
 * The /dh-nav/deferred route does three things AT ONCE in its handler:
 *   1. pushes a SYNCHRONOUS breadcrumb,
 *   2. pushes a DEFERRED Meta title (resolves late),
 *   3. reserves a DEFERRED breadcrumb slot via .defer() resolved by a deep async
 *      component.
 *
 * Resolve-by-default contract:
 *   - SSR / full load: deferred values are resolved SERVER-SIDE, so the initial
 *     HTML shows the resolved title + the resolved breadcrumb set.
 *   - Soft nav: the Breadcrumbs handle has a deferred entry, so the store HOLDS
 *     the PREVIOUS breadcrumbs (the whole handle) until it resolves, then swaps
 *     in [sync crumb, deferred crumb]. Meta likewise holds the previous title.
 *     The consumer never sees a Promise and never a per-crumb pending marker.
 *   - The sync content still renders immediately at commit.
 */

// Long enough to observe the pending state and to navigate away before it
// resolves; short enough to keep the e2e fast.
const DEFER_DELAY = 1500;

const DhNavStartHandler: Handler = (ctx) => {
  ctx.use(Meta)({ title: "DH Nav Start" });
  return (
    <div data-testid="dh-start-page">
      <h1>DH Nav Start</h1>
      <Link to="/dh-nav/deferred" data-testid="dh-to-deferred">
        to deferred
      </Link>
      <Link to="/dh-nav/other" data-testid="dh-to-other">
        to other
      </Link>
    </div>
  );
};

const DhNavOtherHandler: Handler = (ctx) => {
  ctx.use(Meta)({ title: "DH Other" });
  ctx.use(Breadcrumbs)({ label: "DH Other Crumb", href: "/dh-nav/other" });
  return (
    <div data-testid="dh-other-page">
      <h1>DH Other</h1>
      <Link to="/dh-nav" data-testid="dh-other-to-start">
        back to start
      </Link>
      <Link to="/dh-nav/deferred" data-testid="dh-other-to-deferred">
        to deferred
      </Link>
    </div>
  );
};

const DhNavDeferredHandler: Handler = (ctx) => {
  // 1. SYNC breadcrumb — must apply immediately even though Meta is deferred.
  ctx.use(Breadcrumbs)({ label: "DH Sync Crumb", href: "/dh-nav/deferred" });

  // 2. DEFERRED Meta title — resolves late. The store resolves Meta before apply
  //    (it would otherwise suspend MetaTags in <head>); meanwhile the PREVIOUS
  //    title is kept (SWR), never blanked.
  const titleP = new Promise<string>((resolve) =>
    setTimeout(() => resolve("DH Deferred Title"), DEFER_DELAY),
  );
  ctx.use(Meta)(titleP.then((t) => ({ title: t })));

  // 3. DEFERRED breadcrumb via .defer(), resolved by a deep async component.
  //    Resolve-by-default: this is resolved before the consumer reads it (server
  //    on SSR, client before apply on soft nav).
  const resolveCrumb = ctx
    .use(Breadcrumbs)
    .defer({ timeoutMs: 5000, else: null });

  async function DeepResolver() {
    await new Promise((r) => setTimeout(r, DEFER_DELAY));
    resolveCrumb({ label: "DH Deferred Crumb", href: "/dh-nav/deferred/x" });
    return <div data-testid="dh-deep-done">deep done</div>;
  }

  return (
    <div data-testid="dh-deferred-page">
      <h1>DH Deferred</h1>
      {/* Sync content — renders immediately at commit. */}
      <div data-testid="dh-sync-content">sync-content</div>
      <ResolvedTrailBreadcrumbs />
      <Link to="/dh-nav/other" data-testid="dh-deferred-to-other">
        to other
      </Link>
      <Link to="/dh-nav" data-testid="dh-deferred-to-start">
        to start
      </Link>
      {/* DeepResolver streams under its own Suspense so the page commits
          immediately (sync content + sync breadcrumb visible) while it resolves
          the deferred crumb in the background. */}
      <Suspense
        fallback={<div data-testid="dh-deep-loading">deep loading</div>}
      >
        <DeepResolver />
      </Suspense>
    </div>
  );
};

// Server action: bump a cookie-backed counter so the route's DEFERRED title
// differs after the action revalidates (or after a no-JS PE form POST), making
// the resolve observable. The mutation triggers the default route revalidation.
async function bumpDeferredCount(): Promise<void> {
  "use server";
  const prev = Number(cookies().get("dh-act")?.value ?? "0");
  cookies().set("dh-act", String(prev + 1), { path: "/", maxAge: 60 });
}

/**
 * Server-action + progressive-enhancement deferred-handle coverage. Both paths
 * stream a deferred value the GET full-render twin (rsc-rendering.ts, covered by
 * the SSR test) never exercises:
 *   - JS ON: clicking the form runs a server action; the route revalidates and
 *     the partial STREAMS the deferred breadcrumb, which the client resolves
 *     (hold-previous-then-swap) via processHandles — the same client path as a
 *     soft nav. Regression guard for the action-revalidation instance-ordering
 *     fix in server-action-bridge.ts (cache-then-emit so stillLive() holds).
 *   - JS OFF (progressive enhancement): the native form POST is a PE re-render
 *     (progressive-enhancement.ts) that resolves the deferred Meta title
 *     SERVER-side into the returned HTML — no Promise reaches the markup.
 * The cookie counter makes the post-action values differ from the GET values, so
 * each assertion proves the deferred value was actually re-resolved on its path.
 */
const DhNavActionDeferredHandler: Handler = (ctx) => {
  // cookies() reads the request-context cookie store (server-only). On the GET it
  // is unset ("0"); after the action bumps it, the revalidation / PE re-render
  // reads the new value in the SAME request.
  const count = cookies().get("dh-act")?.value ?? "0";

  // Deferred Meta title (no timeout): resolved SERVER-side on the full GET render
  // and on the no-JS PE form-POST re-render (asserted via document.title).
  const titleP = new Promise<string>((resolve) =>
    setTimeout(() => resolve(`Action Deferred Title ${count}`), DEFER_DELAY),
  );
  ctx.use(Meta)(titleP.then((t) => ({ title: t })));

  // Deferred BODY breadcrumb (read via useHandle in ResolvedTrailBreadcrumbs):
  // the observable for the JS-on action path — STREAMED on the action partial and
  // resolved client-side (hold-previous-then-swap), independent of document.title.
  const crumbP = new Promise<{ label: string; href: string }>((resolve) =>
    setTimeout(
      () => resolve({ label: `Action Crumb ${count}`, href: "/dh-nav/action" }),
      DEFER_DELAY,
    ),
  );
  ctx.use(Breadcrumbs)(crumbP);

  return (
    <div data-testid="dh-action-page">
      <h1>DH Action Deferred</h1>
      <div data-testid="dh-action-count">{count}</div>
      <ResolvedTrailBreadcrumbs />
      {/* Inline server-action form: React renders the real progressive-
          enhancement form (method=post + action URL + hidden fields) itself, so
          a no-JS native submit POSTs to the action. Do NOT add an explicit
          method attribute — it hydration-mismatches against React's own. */}
      <form action={bumpDeferredCount}>
        <button type="submit" data-testid="dh-action-submit">
          bump
        </button>
      </form>
    </div>
  );
};

export const deferredHandleNavPatterns = urls(({ path }) => [
  path("/dh-nav", DhNavStartHandler, { name: "dhNav.start" }),
  path("/dh-nav/other", DhNavOtherHandler, { name: "dhNav.other" }),
  path("/dh-nav/deferred", DhNavDeferredHandler, { name: "dhNav.deferred" }),
  path("/dh-nav/action-deferred", DhNavActionDeferredHandler, {
    name: "dhNav.actionDeferred",
  }),
]);
