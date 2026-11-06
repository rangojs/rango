import { Prerender, notFound, redirect } from "@rangojs/router";
import { GuidePlainLoaderValue } from "../components/GuidePlainLoaderValue.js";
import { GuidePlainActionPanel } from "../components/GuidePlainActionPanel.js";

/**
 * KV key of a slug the e2e deleted from the data source. Per mode: the dev
 * and preview servers share the miniflare KV, and their suites can run at the
 * same time.
 */
export const guidePlainGoneKey = (slug: string): string =>
  `gp-gone:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

/** KV key of a slug whose data source the e2e took down: a refresh throws. */
export const guidePlainFailKey = (slug: string): string =>
  `gp-fail:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

/**
 * KV key of a slug the data source moved: holds the URL its render redirects
 * to, so a refresh stores the redirect in place of the page.
 */
export const guidePlainMovedKey = (slug: string): string =>
  `gp-moved:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

// PLAIN (non-Passthrough) on-demand prerender route. Contract under test
// (gateOnDemandProducer): a live PRODUCTION request for a param with no overlay
// entry and no baked entry throws DataNotFoundError -> 404 (the retained
// producer must NOT run live); in dev a miss falls through to a live render.
// The onDemand option MUST be a static literal so the bundle-eviction pass
// retains this producer body for router.prerender().
// A slug the e2e deleted from the data source (guidePlainGoneKey, set by the
// trigger's ?gone=1 op) is a notFound(): a refresh of it stores the "removed"
// marker. A slug it moved (guidePlainMovedKey, ?moved=<path>) throws
// redirect(): a refresh stores the redirect in place of the page.
// "moved-baked" is baked at build time and belongs to the redirect e2e alone,
// so the build-time entry below the overlay is what that test proves is not
// served. Read only on a refresh, where ctx.env is the live env.
export const GuidePlainDef = Prerender<{ slug: string }>(
  async () => [{ slug: "intro" }, { slug: "moved-baked" }],
  async (ctx) => {
    if (ctx.onDemand) {
      const movedTo = await ctx.env.PRERENDER_KV.get(
        guidePlainMovedKey(ctx.params.slug),
      );
      if (movedTo) throw redirect(movedTo, 302);
    }
    if (
      ctx.onDemand &&
      (await ctx.env.PRERENDER_KV.get(guidePlainGoneKey(ctx.params.slug)))
    ) {
      notFound();
    }
    if (
      ctx.onDemand &&
      (await ctx.env.PRERENDER_KV.get(guidePlainFailKey(ctx.params.slug)))
    ) {
      throw new Error("upstream 500");
    }
    // Per-render stamp + entropy: stable across overlay hits (frozen payload),
    // different across renders.
    const stamp = `${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;

    return (
      <div data-testid="gp-detail">
        <p data-testid="gp-source">prerender</p>
        <p data-testid="gp-slug">{ctx.params.slug}</p>
        <p data-testid="gp-ondemand">{String(ctx.onDemand)}</p>
        <p data-testid="gp-stamp">{stamp}</p>
        <GuidePlainLoaderValue />
        <GuidePlainActionPanel slug={ctx.params.slug} />
      </div>
    );
  },
  {
    onDemand: {
      ttl: 3600,
      tags: ({ params }) => ["guide-plain:" + params.slug],
    },
  },
);

// SWR fixture: ttl 1s opens the stale window fast. A stale overlay hit still
// serves (200) and schedules the router-level onRevalidate (see router.tsx),
// which writes a KV marker the e2e polls via the trigger's ?swrlog=1 op.
export const GuideSwrDef = Prerender<{ slug: string }>(
  async () => [{ slug: "swr" }],
  async (ctx) => (
    <div data-testid="gswr-detail">
      <p data-testid="gswr-slug">{ctx.params.slug}</p>
    </div>
  ),
  { onDemand: { ttl: 1 } },
);
