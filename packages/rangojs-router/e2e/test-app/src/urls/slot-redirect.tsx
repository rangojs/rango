import { urls, Prerender, redirect, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import type { AppEnv } from "../router.js";

// redirect() from a parallel slot handler: returned or thrown, it redirects
// like a route or layout handler's, on the document and on a client
// navigation. The slot is a layout's, or the route's own.
//
// The on-demand page sits under a layout whose slot redirects for a slug in
// `redirectingSlugs` (the trigger's ?redirect=1 / ?redirect=0): a refresh then
// is render-failed, and the page stored before keeps serving.
const redirectingSlugs = new Set<string>();

const TARGET = "/slot-redirect/target";

function Shell() {
  return (
    <section data-testid="sr-shell">
      <Outlet />
      <ParallelOutlet name="@aside" />
    </section>
  );
}

const SlotRedirectOnDemandDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div data-testid="sr-od-detail">
      <p data-testid="sr-od-slug">{ctx.params.slug}</p>
      <p data-testid="sr-od-stamp">{new Date().toISOString()}</p>
    </div>
  ),
  { onDemand: { ttl: 3600 } },
);

// ?redirect=1 / ?redirect=0 make the slot redirect for the slug / stop;
// otherwise refreshes the page and returns the PrerenderResult as JSON.
const SlotRedirectTrigger: Handler<{ slug: string }> = async (ctx) => {
  const toggle = ctx.searchParams.get("redirect");
  if (toggle) {
    if (toggle === "1") redirectingSlugs.add(ctx.params.slug);
    else redirectingSlugs.delete(ctx.params.slug);
    return Response.json({ redirect: redirectingSlugs.has(ctx.params.slug) });
  }
  const { router } = await import("../router.js");
  const result = await router.prerender({ env: ctx.env as AppEnv })(
    `/slot-redirect/on-demand/${ctx.params.slug}`,
  );
  return Response.json(
    !result.ok && result.error instanceof Response
      ? {
          ...result,
          error: {
            status: result.error.status,
            location: result.error.headers.get("location"),
          },
        }
      : result,
  );
};

export const slotRedirectPatterns = urls(({ path, layout, parallel }) => [
  path(
    "/",
    () => (
      <nav data-testid="sr-index">
        <Link to="/slot-redirect/layout-slot" data-testid="sr-link-layout">
          layout slot
        </Link>
        <Link to="/slot-redirect/route-slot" data-testid="sr-link-route">
          route slot
        </Link>
        <Link to="/slot-redirect/thrown" data-testid="sr-link-thrown">
          thrown
        </Link>
      </nav>
    ),
    { name: "index" },
  ),
  path("/target", () => <p data-testid="sr-target">arrived</p>, {
    name: "target",
  }),
  layout(Shell, () => [
    parallel({ "@aside": () => redirect(TARGET, 302) }),
    path("/layout-slot", () => <p data-testid="sr-page">page</p>, {
      name: "layoutSlot",
    }),
  ]),
  path(
    "/route-slot",
    () => <p data-testid="sr-page">page</p>,
    { name: "routeSlot" },
    () => [parallel({ "@aside": async () => redirect(TARGET, 302) })],
  ),
  layout(Shell, () => [
    parallel({
      "@aside": async () => {
        throw redirect(TARGET, 302);
      },
    }),
    path("/thrown", () => <p data-testid="sr-page">page</p>, {
      name: "thrown",
    }),
  ]),
  layout(Shell, () => [
    parallel({
      "@aside": (ctx) =>
        redirectingSlugs.has((ctx.params as { slug: string }).slug) ? (
          redirect(TARGET, 302)
        ) : (
          <aside data-testid="sr-od-aside">aside</aside>
        ),
    }),
    path("/on-demand/:slug", SlotRedirectOnDemandDef, { name: "onDemand" }),
  ]),
  path("/trigger/:slug", SlotRedirectTrigger, { name: "trigger" }),
]);
