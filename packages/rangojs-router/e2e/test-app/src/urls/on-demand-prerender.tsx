import {
  urls,
  Prerender,
  Passthrough,
  cookies,
  notFound,
  type Handler,
} from "@rangojs/router";
import { declineSlugs, failSlugs, goneSlugs } from "../od-gone.js";
import { FreshStampLoader, PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
import { OnDemandFreshStamp } from "../components/OnDemandFreshStamp.js";
import { OnDemandActionPanel } from "../components/OnDemandActionPanel.js";
import { swrLog } from "../swr-log.js";
// Type-only (erased — no runtime cycle with router.tsx). This app declares an
// empty AppBindings, so DefaultEnv collapses to `unknown` and ctx.env needs an
// explicit app-env annotation to satisfy router.prerender's TEnv slot. An app
// with real bindings types ctx.env directly and needs no cast.
import type { AppEnv } from "../router.js";
import type { PrerenderResult } from "@rangojs/router/prerender";

// Serialize a PrerenderResult for the e2e: Error instances don't survive
// Response.json, so flatten to the message.
function flattenResult(result: PrerenderResult): unknown {
  return !result.ok && result.error instanceof Error
    ? { ...result, error: result.error.message }
    : result;
}

function prerenderResultJson(result: PrerenderResult): Response {
  return Response.json(flattenResult(result));
}

// On-demand (ISR-style) prerender fixture.
//
// The Prerender definition is BOTH the build-time producer (getParams bakes
// "baked" in production) and the on-demand producer that router.prerender()
// runs requestlessly. Discovery marks the route `od: true` from the evaluated
// option and the eviction pass retains the producer code in prod.
//
// ctx.onDemand is true during an on-demand refresh, false during a static build
// render. od-stamp is captured ONCE per render, so a stored (overlay/baked)
// entry replays an identical stamp across serves — the frozen-payload proof.
// "removable" is baked for the removal e2e alone, which removes its page, and
// "decline-baked" for the decline e2e alone, which toggles its decline.
export const OnDemandDetailDef = Prerender<{ slug: string }>(
  async () => [
    { slug: "baked" },
    { slug: "removable" },
    { slug: "decline-baked" },
  ],
  async (ctx) => {
    // A param the build handler declines: the live handler answers for it
    // (skipped-passthrough). Prefix-keyed so no other test's slug is touched.
    if (
      ctx.params.slug.startsWith("declined-") ||
      declineSlugs.has(ctx.params.slug)
    ) {
      return ctx.passthrough();
    }
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
// `{ route, params }` target does not typecheck against this router: its
// accumulated route map carries a string index signature (`keyof` is
// `string`), so the mapped object-target union collapses to one member whose
// params are `never`. `router.reverse()` infers the route name instead and is
// unaffected; cloudflare-basic's triggers use the object target.
//
// ?remove=1 removes the page instead (prerender.remove()): the live handler
// answers the next request. ?decline=1 / ?decline=0 make the build handler
// decline the slug (ctx.passthrough()) / stop declining it.
export const OnDemandTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const prerender = router.prerender({ env: ctx.env as AppEnv });
  const decline = ctx.searchParams.get("decline");
  if (decline) {
    if (decline === "1") declineSlugs.add(ctx.params.slug);
    else declineSlugs.delete(ctx.params.slug);
    return Response.json({ decline: declineSlugs.has(ctx.params.slug) });
  }
  const target = `/on-demand/${ctx.params.slug}`;
  const result =
    ctx.searchParams.get("remove") === "1"
      ? await prerender.remove(target)
      : await prerender(target);
  return prerenderResultJson(result);
};

// PLAIN (no Passthrough) onDemand route. Production contract on a miss
// (overlay + baked manifest): the retained producer must NOT run live —
// gateOnDemandProducer throws DataNotFoundError -> 404. Dev keeps the live
// fall-through. od-plain-stamp is captured once per render (frozen-payload
// proof); the FreshStampLoader value differs per request (loaders-fresh proof).
// A slug the e2e deleted from the data source (goneSlugs) is a notFound(): a
// refresh of it stores the "removed" marker.
export const OnDemandPlainDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => {
    if (goneSlugs.has(ctx.params.slug)) notFound();
    if (failSlugs.has(ctx.params.slug)) throw new Error("upstream 500");
    const stamp = new Date().toISOString();
    return (
      <div data-testid="od-plain-detail">
        <p data-testid="od-plain-source">prerender</p>
        <p data-testid="od-plain-slug">{ctx.params.slug}</p>
        <p data-testid="od-plain-ondemand">{String(ctx.onDemand)}</p>
        <p data-testid="od-plain-stamp">{stamp}</p>
        <OnDemandFreshStamp loader={FreshStampLoader} />
        <OnDemandActionPanel slug={ctx.params.slug} />
      </div>
    );
  },
  {
    onDemand: { ttl: 3600, tags: ({ params }) => ["od-plain:" + params.slug] },
  },
);

// Trigger for the plain route. Query switches exercise the trigger's
// companions: ?onlyIfStale=1 (cron-sweep opt-in -> "already-fresh" on a fresh
// entry), ?markStale=<tag> (marks matching entries stale), ?remove=1
// (prerender.remove(): the "removed" marker, nothing rendered) and ?gone=1 /
// ?gone=0 (delete / restore the slug in the data source, so the next refresh
// hits notFound() or renders again), ?fail=1 / ?fail=0 (the data source goes
// down / comes back: a refresh throws something other than notFound()) and
// repeated ?target=<path> (prerender.many(targets), the results as a JSON
// array in target order).
export const OnDemandPlainTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("../router.js");
  const prerender = router.prerender({ env: ctx.env as AppEnv });
  const staleTag = ctx.searchParams.get("markStale");
  if (staleTag) {
    await prerender.markStale([staleTag]);
    return Response.json({ markedStale: staleTag });
  }
  const gone = ctx.searchParams.get("gone");
  if (gone) {
    if (gone === "1") goneSlugs.add(ctx.params.slug);
    else goneSlugs.delete(ctx.params.slug);
    return Response.json({ gone: goneSlugs.has(ctx.params.slug) });
  }
  const fail = ctx.searchParams.get("fail");
  if (fail) {
    if (fail === "1") failSlugs.add(ctx.params.slug);
    else failSlugs.delete(ctx.params.slug);
    return Response.json({ fail: failSlugs.has(ctx.params.slug) });
  }
  const targets = ctx.searchParams.getAll("target");
  if (targets.length > 0) {
    return Response.json((await prerender.many(targets)).map(flattenResult));
  }
  const target = `/on-demand-plain/${ctx.params.slug}`;
  if (ctx.searchParams.get("remove") === "1") {
    return prerenderResultJson(await prerender.remove(target));
  }
  const result = await prerender(
    target,
    ctx.searchParams.get("onlyIfStale") === "1"
      ? { onlyIfStale: true }
      : undefined,
  );
  return prerenderResultJson(result);
};

// SWR fixture: ttl 1s so a triggered overlay entry goes stale fast. A stale
// overlay hit still serves but (router prerender config: onRevalidate)
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
  const result = await router.prerender({ env: ctx.env as AppEnv })(
    `/on-demand-swr/${ctx.params.slug}`,
  );
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
  const result = await router.prerender({ env: ctx.env as AppEnv })(
    `/on-demand-personalized/${ctx.params.slug}`,
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
