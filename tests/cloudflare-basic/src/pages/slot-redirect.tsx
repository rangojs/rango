import { Prerender, redirect, urls, type Handler } from "@rangojs/router";
import { Link, ParallelOutlet } from "@rangojs/router/client";
import type { PrerenderResult } from "@rangojs/router/prerender";

// A parallel slot handler's redirect() short-circuits as a route handler's
// does (resolveParallelSlotComponent runs the slot's result through
// handleHandlerResult): the document request answers 302 with its Location, a
// Link click lands on the target, and an on-demand refresh reports
// render-failed with the Response while the page stored before keeps serving.
//
// The stored route's slot redirects only for a slug the trigger armed, so the
// page can be stored first and served after the failed refresh.
const TARGET = "/slot-redirect/target";

/**
 * KV key arming a slug's slot. Per mode: the dev and preview servers share
 * the miniflare KV, and their suites can run at the same time.
 */
const slotRedirectKey = (slug: string): string =>
  `sr-flag:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

const SlotRedirectStoredDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div data-testid="sr-stored">
      <p data-testid="sr-stored-slug">{ctx.params.slug}</p>
      <ParallelOutlet name="@aside" />
    </div>
  ),
  { onDemand: true },
);

/** JSON for the e2e: a Response error does not survive Response.json. */
function refreshJson(result: PrerenderResult): Response {
  if (result.ok) return Response.json(result);
  const error = result.error;
  const response = error instanceof Response ? error : null;
  return Response.json({
    ok: false,
    status: result.status,
    errorStatus: response?.status ?? null,
    errorLocation: response?.headers.get("location") ?? null,
    errorName: error instanceof Error ? error.message : null,
  });
}

/**
 * Arm the stored route's slot (?redirect=1 / ?redirect=0), or refresh it and
 * report the result.
 */
const SlotRedirectTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { slug } = ctx.params;
  const key = slotRedirectKey(slug);
  const flag = ctx.url.searchParams.get("redirect");
  if (flag) {
    if (flag === "1") await ctx.env.PRERENDER_KV.put(key, "1");
    else await ctx.env.PRERENDER_KV.delete(key);
    return Response.json({ redirect: flag === "1" });
  }
  const { router } = await import("../router.js");
  return refreshJson(
    await router.prerender({ env: ctx.env, ctx: ctx.executionContext })({
      route: "slotRedirect.stored",
      params: { slug },
    }),
  );
};

export const slotRedirectPatterns = urls(({ path, loading, parallel }) => [
  path(
    "/",
    () => (
      <div data-testid="sr-index">
        <Link to="/slot-redirect/page" data-testid="sr-link">
          go to the slot page
        </Link>
        <Link to="/slot-redirect/loading" data-testid="sr-loading-link">
          go to the loading slot page
        </Link>
      </div>
    ),
    { name: "index" },
  ),
  // A route-scoped slot the client lacks on the way in from the index.
  path(
    "/page",
    () => (
      <div data-testid="sr-page">
        <p>page body</p>
        <ParallelOutlet name="@aside" />
      </div>
    ),
    { name: "page" },
    () => [parallel({ "@aside": () => redirect(TARGET, 302) })],
  ),
  // The slot declares loading(): its handler streams, but a synchronously
  // returned redirect() still short-circuits before the stream takes over, as
  // a route handler's does on a loading() route.
  path(
    "/loading",
    () => (
      <div data-testid="sr-loading-page">
        <p>page body</p>
        <ParallelOutlet name="@aside" />
      </div>
    ),
    { name: "loading" },
    () => [
      parallel({ "@aside": () => redirect(TARGET, 302) }, () => [
        loading(<p data-testid="sr-loading">slot loading</p>),
      ]),
    ],
  ),
  path("/stored/:slug", SlotRedirectStoredDef, { name: "stored" }, () => [
    parallel({
      "@aside": async (ctx) =>
        (await ctx.env.PRERENDER_KV.get(slotRedirectKey(ctx.params.slug))) ? (
          redirect(TARGET, 302)
        ) : (
          <div data-testid="sr-stored-slot">stored slot</div>
        ),
    }),
  ]),
  path("/trigger/:slug", SlotRedirectTrigger, { name: "trigger" }),
  path("/target", () => <div data-testid="sr-target">arrived</div>, {
    name: "target",
  }),
]);
