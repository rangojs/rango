import { Prerender, redirect, urls, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import type { ReactNode } from "react";
import type { PrerenderResult } from "@rangojs/router/prerender";

/**
 * Workerd twin of packages/rangojs-router/e2e/test-app/src/urls/
 * slot-redirect.tsx: a parallel slot handler's returned redirect()
 * short-circuits the request like a route or layout handler's, on a document
 * request, a client navigation and an on-demand refresh. Pins the fix on the
 * Cloudflare runtime, not just the node dev server.
 *
 * Why it happens: the slot handler's result reached the segment walk raw
 * (resolveParallelSlotComponent, segment-resolution/revalidation.ts), so the
 * Response became the slot's component and only surfaced during Flight
 * serialization.
 */

/**
 * KV key of the flag that makes the on-demand page's slot redirect, set by the
 * trigger's ?slot=1. Per mode: the dev and preview servers share the miniflare
 * KV, and their suites can run at the same time.
 */
export const slotRedirectKey = (): string =>
  `sr-redirect:${import.meta.env.DEV ? "dev" : "prod"}`;

const TARGET = "/slot-redirect/target";

/** The slot: renders, except on the redirecting page and the flagged od page. */
async function asideSlot(ctx: {
  url: URL;
  env: { PRERENDER_KV: KVNamespace };
}): Promise<ReactNode> {
  if (
    ctx.url.pathname === "/slot-redirect/redirect" ||
    (await ctx.env.PRERENDER_KV.get(slotRedirectKey())) === "1"
  ) {
    return redirect(TARGET, 302) as unknown as ReactNode;
  }
  return <aside data-testid="cf-sr-aside">aside body</aside>;
}

/** An on-demand page under the slot's layout: its stamp proves what served. */
const SlotRedirectOnDemand = Prerender<{}>(
  async () => [],
  async () => (
    <div data-testid="cf-sr-od">
      <p data-testid="cf-sr-od-stamp">
        {`${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`}
      </p>
    </div>
  ),
  { onDemand: true },
);

/** The refresh's result, with a Response error readable as JSON. */
function resultJson(result: PrerenderResult): Response {
  const error = result.ok ? undefined : result.error;
  return Response.json({
    ...result,
    error:
      error instanceof Response
        ? {
            response: error.status,
            location: error.headers.get("location"),
          }
        : error instanceof Error
          ? { message: error.message }
          : undefined,
  });
}

// `?slot=1` / `?slot=0` make the on-demand page's slot redirect / stop
// redirecting; no query refreshes the page and returns its PrerenderResult.
// Outside the slot's layout, so its own render never redirects.
const SlotRedirectTrigger: Handler = async (ctx) => {
  const flag = ctx.url.searchParams.get("slot");
  if (flag !== null) {
    if (flag === "1") await ctx.env.PRERENDER_KV.put(slotRedirectKey(), "1");
    else await ctx.env.PRERENDER_KV.delete(slotRedirectKey());
    return Response.json({ redirecting: flag === "1" });
  }
  const { router } = await import("../router.js");
  const prerender = router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  });
  return resultJson(await prerender("/slot-redirect/od"));
};

export const slotRedirectPatterns = urls(({ path, layout, parallel }) => [
  layout(
    () => (
      <main>
        <Outlet />
      </main>
    ),
    () => [
      path(
        "/",
        () => (
          <div data-testid="cf-sr-index">
            <Link
              to="/slot-redirect/redirect"
              data-testid="cf-sr-link-redirect"
            >
              redirecting page
            </Link>
          </div>
        ),
        { name: "index" },
      ),
    ],
  ),
  layout(
    () => (
      <div>
        <nav>slot layout</nav>
        <Outlet />
        <ParallelOutlet name="@aside" />
      </div>
    ),
    () => [
      parallel({ "@aside": asideSlot }),
      path("/plain", () => <p data-testid="cf-sr-plain">plain page</p>, {
        name: "plain",
      }),
      path(
        "/redirect",
        () => <p data-testid="cf-sr-page">redirecting page</p>,
        { name: "redirect" },
      ),
      path("/od", SlotRedirectOnDemand, { name: "od" }),
    ],
  ),
  path("/target", () => <p data-testid="cf-sr-target">arrived</p>, {
    name: "target",
  }),
  path("/od-trigger", SlotRedirectTrigger, { name: "odTrigger" }),
]);
