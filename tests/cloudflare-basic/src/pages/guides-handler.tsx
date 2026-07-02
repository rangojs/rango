import { Prerender, Passthrough } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

// Known slugs that get pre-rendered at build time.
// Unknown slugs fall through to the Passthrough live handler.
const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
};

export const GuidesDetailDef = Prerender<{ slug: string }>(
  async () => Object.keys(knownGuides).map((slug) => ({ slug })),
  async (ctx) => {
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
