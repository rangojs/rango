import { Prerender } from "@rangojs/router";
import { GuidePlainLoaderValue } from "../components/GuidePlainLoaderValue.js";

// PLAIN (non-Passthrough) on-demand prerender route. Contract under test
// (gateOnDemandProducer): a live PRODUCTION request for a param with no overlay
// entry and no baked entry throws DataNotFoundError -> 404 (the retained
// producer must NOT run live); in dev a miss falls through to a live render.
// The onDemand option MUST be a static literal so the bundle-eviction pass
// retains this producer body for router.prerender().
export const GuidePlainDef = Prerender<{ slug: string }>(
  async () => [{ slug: "intro" }],
  async (ctx) => {
    // Per-render stamp + entropy: stable across overlay hits (frozen payload),
    // different across renders.
    const stamp = `${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;

    return (
      <div data-testid="gp-detail">
        <p data-testid="gp-source">prerender</p>
        <p data-testid="gp-slug">{ctx.params.slug}</p>
        <p data-testid="gp-stamp">{stamp}</p>
        <GuidePlainLoaderValue />
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
