import { urls, Prerender, Passthrough, type Handler } from "@rangojs/router";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
// Type-only (erased — no runtime cycle with router.tsx). This app declares an
// empty AppBindings, so DefaultEnv collapses to `unknown` and ctx.env needs an
// explicit app-env annotation to satisfy router.prerender's TEnv slot. An app
// with real bindings types ctx.env directly and needs no cast.
import type { AppEnv } from "../router.js";

// On-demand (ISR-style) prerender fixture.
//
// The Prerender definition is BOTH the build-time producer (getParams bakes
// "baked" in production) and the on-demand producer that router.prerender()
// runs requestlessly. `{ onDemand }` is a static literal so discovery marks the
// route `od: true` and the eviction pass retains the producer code in prod.
//
// ctx.onDemand is true during an on-demand refresh, false during a static build
// render. od-stamp is captured ONCE per render, so a stored (overlay/baked)
// entry replays an identical stamp across serves — the frozen-payload proof.
export const OnDemandDetailDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => {
    const stamp = new Date().toISOString();
    return (
      <div data-testid="od-detail">
        <p data-testid="od-source">prerender</p>
        <p data-testid="od-slug">{ctx.params.slug}</p>
        <p data-testid="od-ondemand">{String(ctx.onDemand)}</p>
        <p data-testid="od-stamp">{stamp}</p>
        <PrerenderClientTest loader={PrerenderTestLoader} />
      </div>
    );
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`od:${params.slug}`] } },
);

// Live fallback for params with no stored entry (unbuilt + not-yet-triggered).
// od-stamp carries per-call entropy so two consecutive live serves differ,
// proving the live handler re-runs each request.
export const OnDemandDetail = Passthrough(OnDemandDetailDef, async (ctx) => {
  const stamp = `${new Date().toISOString()}-${Math.random().toString(36).slice(2)}`;
  // A live serve is never an on-demand render — onDemand is a BuildContext-only
  // flag, absent from the live HandlerContext — so it is a fixed "false" here.
  return (
    <div data-testid="od-detail">
      <p data-testid="od-source">live</p>
      <p data-testid="od-slug">{ctx.params.slug}</p>
      <p data-testid="od-ondemand">false</p>
      <p data-testid="od-stamp">{stamp}</p>
      <PrerenderClientTest loader={PrerenderTestLoader} />
    </div>
  );
});

// Requestless trigger: renders + stores the on-demand entry for :slug, then
// returns the PrerenderResult as JSON so the e2e can assert { ok, status }.
// Lazily imports the router so this module has no import cycle with router.tsx.
//
// Uses the path-string target (the design doc's headline form). The typed
// `{ route, params }` target does not typecheck against this router instance:
// `router.prerender` is `PrerenderFn<TEnv, TRoutes>` and the fluent
// `createRouter().routes(...)` leaves the phantom `TRoutes` as `{}`, so
// `PrerenderTarget<{}>` collapses to `string | URL` (unlike `reverse`, the
// object target has no generated-route-map global fallback).
export const OnDemandTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const result = await router.prerender(`/on-demand/${ctx.params.slug}`, {
    env: ctx.env as AppEnv,
  });
  return Response.json(result);
};

export const onDemandPatterns = urls(({ path, loader }) => [
  path("/on-demand/:slug", OnDemandDetail, { name: "onDemandDetail" }, () => [
    loader(PrerenderTestLoader),
  ]),
  path("/od-trigger/:slug", OnDemandTrigger, { name: "onDemandTrigger" }),
]);
