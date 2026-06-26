import { urls, Meta, Breadcrumbs, type Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Suspense } from "react";
import { ResolvedTrailBreadcrumbs } from "../components/DeferredHandleNav.js";

/**
 * Resolve-by-default deferred-handle navigation + the P1 history-cache poisoning
 * fix on the Cloudflare (workerd) preset, mirroring
 * packages/rangojs-router/e2e/test-app/src/urls/deferred-handle-nav.tsx.
 *
 * Resolve-by-default contract:
 *   - SSR / full load: deferred values resolve SERVER-SIDE, so the initial HTML
 *     carries the resolved title + resolved breadcrumb set.
 *   - Soft nav: the Breadcrumbs handle has a deferred entry, so the store HOLDS
 *     the previous breadcrumbs (whole handle) until resolved, then swaps in
 *     [sync crumb, deferred crumb]. Meta holds the previous title. No Promise and
 *     no per-crumb pending marker reach the consumer.
 *   - The sync content still renders immediately at commit.
 */

// Long enough to observe the pending state and to navigate away before it
// resolves; short enough to keep the e2e fast. Must match DEFER_DELAY in
// tests/cloudflare-basic/e2e/deferred-handle-nav.test.ts.
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
  //    Resolve-by-default: resolved before the consumer reads it.
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

export const deferredHandleNavPatterns = urls(({ path }) => [
  path("/dh-nav", DhNavStartHandler, { name: "dhNav.start" }),
  path("/dh-nav/other", DhNavOtherHandler, { name: "dhNav.other" }),
  path("/dh-nav/deferred", DhNavDeferredHandler, { name: "dhNav.deferred" }),
]);
