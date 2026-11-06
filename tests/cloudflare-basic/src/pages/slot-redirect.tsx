import { urls, Prerender, redirect, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

// redirect() from a parallel slot handler: returned or thrown, it redirects
// like a route or layout handler's, on the document and on a client
// navigation. The slot is a layout's, or the route's own.
//
// The on-demand page sits under a layout whose slot redirects for a slug the
// trigger marked (?redirect=1 / ?redirect=0, a KV key): a refresh then is
// render-failed, and the page stored before keeps serving.

const TARGET = "/slot-redirect/target";

/** Per mode: the dev and preview servers share the miniflare KV. */
const redirectingKey = (slug: string): string =>
  `sr-redirect:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

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
      <p data-testid="sr-od-stamp">
        {`${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`}
      </p>
    </div>
  ),
  { onDemand: { ttl: 3600 } },
);

// ?redirect=1 / ?redirect=0 make the slot redirect for the slug / stop;
// otherwise refreshes the page and returns the PrerenderResult as JSON, the
// redirect a failed refresh carries as its status and location.
export const SlotRedirectTrigger: Handler<{ slug: string }> = async (ctx) => {
  const toggle = ctx.url.searchParams.get("redirect");
  if (toggle) {
    const key = redirectingKey(ctx.params.slug);
    if (toggle === "1") await ctx.env.PRERENDER_KV.put(key, "1");
    else await ctx.env.PRERENDER_KV.delete(key);
    return Response.json({ redirect: toggle === "1" });
  }
  const { router } = await import("../router.js");
  const result = await router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  })(`/slot-redirect/on-demand/${ctx.params.slug}`);
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
      "@aside": async (ctx) =>
        (await ctx.env.PRERENDER_KV.get(
          redirectingKey((ctx.params as { slug: string }).slug),
        )) ? (
          redirect(TARGET, 302)
        ) : (
          <aside data-testid="sr-od-aside">aside</aside>
        ),
    }),
    path("/on-demand/:slug", SlotRedirectOnDemandDef, { name: "onDemand" }),
  ]),
  path("/trigger/:slug", SlotRedirectTrigger, { name: "trigger" }),
]);
