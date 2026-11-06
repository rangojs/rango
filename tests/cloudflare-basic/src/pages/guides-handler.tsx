import { Prerender, Passthrough, cookies, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

// Known slugs that get pre-rendered at build time.
// Unknown slugs fall through to the Passthrough live handler.
// "removable" is baked for the removal e2e alone
// (e2e/prerender-ondemand.test.ts), which removes its page, and
// "decline-baked" for the decline e2e alone, which toggles its decline, and
// "moved-baked" for the redirect e2e alone, which moves it to another URL.
const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
  removable: "Removable Guide",
  "decline-baked": "Decline Baked Guide",
  "moved-baked": "Moved Baked Guide",
};

/**
 * KV key of a slug whose build handler declines (ctx.passthrough()), set by
 * the trigger's ?decline=1. Per mode: the dev and preview servers share the
 * miniflare KV.
 */
export const guideDeclineKey = (slug: string): string =>
  `guide-decline:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

/**
 * KV key of a slug whose guide moved to another URL, set by the trigger's
 * ?moved=1: both handlers answer redirect(MOVED_GUIDE_TO) for it, so a refresh
 * has no page to store and stores the "removed" marker instead. Per mode, for
 * the same reason as guideDeclineKey.
 */
export const guideMovedKey = (slug: string): string =>
  `guide-moved:${import.meta.env.DEV ? "dev" : "prod"}:${slug}`;

/** Where a moved guide redirects: a page this app serves. */
export const MOVED_GUIDE_TO = "/guides/routing";

export const GuidesDetailDef = Prerender<{ slug: string }>(
  async () => Object.keys(knownGuides).map((slug) => ({ slug })),
  async (ctx) => {
    // A param the build handler declines: the live handler answers for it
    // (skipped-passthrough). Prefix-keyed so no other test's slug is touched.
    if (
      ctx.params.slug.startsWith("declined-") ||
      (ctx.onDemand &&
        (await ctx.env.PRERENDER_KV.get(guideDeclineKey(ctx.params.slug))))
    ) {
      return ctx.passthrough();
    }
    if (
      ctx.onDemand &&
      (await ctx.env.PRERENDER_KV.get(guideMovedKey(ctx.params.slug)))
    ) {
      throw redirect(MOVED_GUIDE_TO);
    }
    const title = knownGuides[ctx.params.slug] ?? `Guide: ${ctx.params.slug}`;
    const renderedAt = new Date().toISOString();

    return (
      <div data-testid="guide-detail">
        <h1 data-testid="guide-title">{title}</h1>
        <p data-testid="guide-build">Build: {String(ctx.build)}</p>
        <p data-testid="guide-source">prerender</p>
        <p data-testid="guide-ondemand">
          {String((ctx as any).onDemand ?? false)}
        </p>
        <p data-testid="guide-rendered-at">Rendered at: {renderedAt}</p>
        <p data-testid="guide-slug">Slug: {ctx.params.slug}</p>
        <nav style={{ marginTop: "1rem" }}>
          <Link
            to={ctx.reverse("guides.detail", { slug: "routing" })}
            data-testid="guide-link-routing"
          >
            Routing
          </Link>
          {" | "}
          <Link
            to={ctx.reverse("guides.detail", { slug: "caching" })}
            data-testid="guide-link-caching"
          >
            Caching
          </Link>
          {" | "}
          <Link
            to={ctx.reverse("guides.detail", { slug: "dynamic-test" })}
            data-testid="guide-link-dynamic"
          >
            Dynamic Test
          </Link>
        </nav>
      </div>
    );
  },
  // On-demand (ISR-style) refresh opt-in. MUST be a static literal so the
  // bundle-eviction pass retains this producer body for router.prerender().
  { onDemand: { ttl: 3600, tags: ({ params }) => [`guide:${params.slug}`] } },
);

export const GuidesDetail = Passthrough(GuidesDetailDef, async (ctx) => {
  if (await ctx.env.PRERENDER_KV.get(guideMovedKey(ctx.params.slug))) {
    throw redirect(MOVED_GUIDE_TO);
  }
  const title = knownGuides[ctx.params.slug] ?? `Guide: ${ctx.params.slug}`;
  const renderedAt = new Date().toISOString();

  return (
    <div data-testid="guide-detail">
      <h1 data-testid="guide-title">{title}</h1>
      <p data-testid="guide-build">Build: {String(ctx.build)}</p>
      <p data-testid="guide-source">live</p>
      <p data-testid="guide-ondemand">
        {String((ctx as any).onDemand ?? false)}
      </p>
      <p data-testid="guide-rendered-at">Rendered at: {renderedAt}</p>
      <p data-testid="guide-slug">Slug: {ctx.params.slug}</p>
      <nav style={{ marginTop: "1rem" }}>
        <Link
          to={ctx.reverse("guides.detail", { slug: "routing" })}
          data-testid="guide-link-routing"
        >
          Routing
        </Link>
        {" | "}
        <Link
          to={ctx.reverse("guides.detail", { slug: "caching" })}
          data-testid="guide-link-caching"
        >
          Caching
        </Link>
        {" | "}
        <Link
          to={ctx.reverse("guides.detail", { slug: "dynamic-test" })}
          data-testid="guide-link-dynamic"
        >
          Dynamic Test
        </Link>
      </nav>
    </div>
  );
});

async function PersonalizedGuideChild({ slug }: { slug: string }) {
  cookies().get("session");
  return <p>{slug}</p>;
}

const PersonalizedGuideDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <PersonalizedGuideChild slug={ctx.params.slug} />,
  { onDemand: true },
);

export const PersonalizedGuide = Passthrough(
  PersonalizedGuideDef,
  async (ctx) => (
    <p data-testid="guide-personalized-source">live:{ctx.params.slug}</p>
  ),
);
