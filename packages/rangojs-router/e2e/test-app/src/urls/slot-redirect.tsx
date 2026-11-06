import {
  urls,
  redirect,
  Prerender,
  type Handler,
  type HandlerContext,
} from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import type { ReactNode } from "react";
import type { PrerenderResult } from "@rangojs/router/prerender";
// Type-only (erased): this app declares empty bindings, so ctx.env needs the
// app-env annotation to satisfy router.prerender's TEnv slot.
import type { AppEnv } from "../router.js";

// A parallel slot handler's redirect.
//
// A slot handler's returned Response is control flow, exactly like a route or
// layout handler's: a document request answers 302 with Location, a client
// navigation answers a Flight redirect, and an on-demand refresh reports the
// redirect and leaves the page stored before serving. Before that funnel
// existed, the Response became the slot's component and surfaced during Flight
// serialization instead ("Only plain objects, and a few built-ins, can be
// passed to Client Components").
//
// `odSlotRedirects` makes the on-demand page's slot start redirecting after its
// page was stored, so a refresh meets the redirect the way a moved page does.
let odSlotRedirects = false;

const TARGET = "/slot-redirect/target";

/** The slot: renders, except on the redirecting page and the toggled od page. */
function asideSlot(ctx: HandlerContext<any>): ReactNode {
  if (ctx.url.pathname === "/slot-redirect/redirect" || odSlotRedirects) {
    return redirect(TARGET, 302) as unknown as ReactNode;
  }
  return <aside data-testid="sr-aside">aside body</aside>;
}

/** An on-demand page under the slot's layout: its stamp proves what served. */
const SlotRedirectOnDemand = Prerender<{}>(
  async () => [],
  async () => (
    <div data-testid="sr-od">
      <p data-testid="sr-od-stamp">{new Date().toISOString()}</p>
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
  const flag = ctx.searchParams.get("slot");
  if (flag !== null) {
    odSlotRedirects = flag === "1";
    return Response.json({ odSlotRedirects });
  }
  const { router } = await import("../router.js");
  const prerender = router.prerender({ env: ctx.env as AppEnv });
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
          <div data-testid="sr-index">
            <Link to="/slot-redirect/redirect" data-testid="sr-link-redirect">
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
      path("/plain", () => <p data-testid="sr-plain">plain page</p>, {
        name: "plain",
      }),
      path("/redirect", () => <p data-testid="sr-page">redirecting page</p>, {
        name: "redirect",
      }),
      path("/od", SlotRedirectOnDemand, { name: "od" }),
    ],
  ),
  path("/target", () => <p data-testid="sr-target">arrived</p>, {
    name: "target",
  }),
  path("/od-trigger", SlotRedirectTrigger, { name: "odTrigger" }),
]);
