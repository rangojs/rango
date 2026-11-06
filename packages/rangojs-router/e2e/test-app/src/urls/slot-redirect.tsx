import { Prerender, redirect, urls, type Handler } from "@rangojs/router";
import { Link, ParallelOutlet } from "@rangojs/router/client";
import type { PrerenderResult } from "@rangojs/router/prerender";
// Type-only (erased — no runtime cycle with router.tsx).
import type { AppEnv } from "../router.js";

// A parallel slot handler's redirect() short-circuits as a route handler's
// does (resolveParallelSlotComponent runs the slot's result through
// handleHandlerResult): the document request answers 302 with its Location, a
// Link click lands on the target, and an on-demand refresh reports
// render-failed with the Response while the page stored before keeps serving.
//
// The stored route's slot redirects only for a slug the trigger armed, so the
// page can be stored first and served after the failed refresh.
const TARGET = "/slot-redirect/target";

const redirectingSlugs = new Set<string>();

const StoredSlotDef = Prerender<{ slug: string }>(
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
  const flag = ctx.searchParams.get("redirect");
  if (flag) {
    if (flag === "1") redirectingSlugs.add(slug);
    else redirectingSlugs.delete(slug);
    return Response.json({ redirect: redirectingSlugs.has(slug) });
  }
  const { router } = await import("../router.js");
  return refreshJson(
    await router.prerender({ env: ctx.env as AppEnv })(
      `/slot-redirect/stored/${slug}`,
    ),
  );
};

export const slotRedirectPatterns = urls(({ path, parallel }) => [
  path(
    "/",
    () => (
      <div data-testid="sr-index">
        <Link to="/slot-redirect/page" data-testid="sr-link">
          go to the slot page
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
  path("/stored/:slug", StoredSlotDef, { name: "stored" }, () => [
    parallel({
      "@aside": (ctx) =>
        redirectingSlugs.has(ctx.params.slug) ? (
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
