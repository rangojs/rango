import {
  urls,
  Prerender,
  Passthrough,
  cookies,
  type Handler,
} from "@rangojs/router";
import { FreshStampLoader, PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
import { OnDemandFreshStamp } from "../components/OnDemandFreshStamp.js";
import { swrLog } from "../swr-log.js";
// Type-only (erased — no runtime cycle with router.tsx). This app declares an
// empty AppBindings, so DefaultEnv collapses to `unknown` and ctx.env needs an
// explicit app-env annotation to satisfy router.prerender's TEnv slot. An app
// with real bindings types ctx.env directly and needs no cast.
import type { AppEnv } from "../router.js";
import type { PrerenderResult } from "@rangojs/router/prerender";

// Serialize a PrerenderResult for the e2e: Error instances don't survive
// Response.json, so flatten to the message.
function prerenderResultJson(result: PrerenderResult): Response {
  return Response.json(
    !result.ok && result.error instanceof Error
      ? { ...result, error: result.error.message }
      : result,
  );
}

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
  return prerenderResultJson(result);
};

// PLAIN (no Passthrough) onDemand route. Production contract on a miss
// (overlay + baked manifest): the retained producer must NOT run live —
// gateOnDemandProducer throws DataNotFoundError -> 404. Dev keeps the live
// fall-through. od-plain-stamp is captured once per render (frozen-payload
// proof); the FreshStampLoader value differs per request (loaders-fresh proof).
export const OnDemandPlainDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => {
    const stamp = new Date().toISOString();
    return (
      <div data-testid="od-plain-detail">
        <p data-testid="od-plain-source">prerender</p>
        <p data-testid="od-plain-slug">{ctx.params.slug}</p>
        <p data-testid="od-plain-stamp">{stamp}</p>
        <OnDemandFreshStamp loader={FreshStampLoader} />
      </div>
    );
  },
  {
    onDemand: { ttl: 3600, tags: ({ params }) => ["od-plain:" + params.slug] },
  },
);

// Trigger for the plain route. Query switches exercise the trigger's
// companions: ?onlyIfStale=1 (cron-sweep opt-in -> "already-fresh" on a fresh
// entry) and ?invalidateTag=<tag> (marks matching entries stale).
export const OnDemandPlainTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const env = ctx.env as AppEnv;
  const invalidateTag = ctx.searchParams.get("invalidateTag");
  if (invalidateTag) {
    await router.prerender.invalidateTags([invalidateTag], { env });
    return Response.json({ invalidated: invalidateTag });
  }
  const result = await router.prerender(
    `/on-demand-plain/${ctx.params.slug}`,
    ctx.searchParams.get("onlyIfStale") === "1"
      ? { env, onlyIfStale: true }
      : { env },
  );
  return prerenderResultJson(result);
};

// SWR fixture: ttl 1s so a triggered overlay entry goes stale fast. A stale
// overlay hit still serves but (router prerender config: swr + onRevalidate)
// schedules a revalidation, observable via /od-swr-log.
//
// Deliberately a NON-literal onDemand spelling: retention is driven by the
// evaluated route manifest ($$id set), not a textual scan of the call — this
// route's whole production e2e flow (refresh, stale serve, swr) pins that a
// shared options const retains the producer.
const SWR_OD_OPTIONS = { onDemand: { ttl: 1 } };

const OnDemandSwrDef = Prerender<{ slug: string }>(
  async () => [{ slug: "swr" }],
  async (ctx) => (
    <div data-testid="od-swr-detail">
      <p data-testid="od-swr-slug">{ctx.params.slug}</p>
    </div>
  ),
  SWR_OD_OPTIONS,
);

const OnDemandSwrTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const result = await router.prerender(`/on-demand-swr/${ctx.params.slug}`, {
    env: ctx.env as AppEnv,
  });
  return prerenderResultJson(result);
};

const SwrLogHandler: Handler = async () => {
  return Response.json(swrLog);
};

async function PersonalizedOnDemandChild({ slug }: { slug: string }) {
  cookies().get("session");
  return <p>{slug}</p>;
}

const PersonalizedOnDemandDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <PersonalizedOnDemandChild slug={ctx.params.slug} />,
  { onDemand: true },
);

const PersonalizedOnDemand = Passthrough(
  PersonalizedOnDemandDef,
  async (ctx) => (
    <p data-testid="od-personalized-source">live:{ctx.params.slug}</p>
  ),
);

const PersonalizedOnDemandTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const result = await router.prerender(
    `/on-demand-personalized/${ctx.params.slug}`,
    { env: ctx.env as AppEnv },
  );
  return prerenderResultJson(result);
};

export const onDemandPatterns = urls(({ path, loader }) => [
  path("/on-demand/:slug", OnDemandDetail, { name: "onDemandDetail" }, () => [
    loader(PrerenderTestLoader),
  ]),
  path("/od-trigger/:slug", OnDemandTrigger, { name: "onDemandTrigger" }),
  path(
    "/on-demand-plain/:slug",
    OnDemandPlainDef,
    { name: "onDemandPlain" },
    () => [loader(FreshStampLoader)],
  ),
  path("/od-plain-trigger/:slug", OnDemandPlainTrigger, {
    name: "onDemandPlainTrigger",
  }),
  path("/on-demand-swr/:slug", OnDemandSwrDef, { name: "onDemandSwr" }),
  path("/od-swr-trigger/:slug", OnDemandSwrTrigger, {
    name: "onDemandSwrTrigger",
  }),
  path("/od-swr-log", SwrLogHandler, { name: "onDemandSwrLog" }),
  path("/on-demand-personalized/:slug", PersonalizedOnDemand, {
    name: "onDemandPersonalized",
  }),
  path("/od-personalized-trigger/:slug", PersonalizedOnDemandTrigger, {
    name: "onDemandPersonalizedTrigger",
  }),
]);
