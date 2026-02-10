import { createPrerenderHandler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { reverse } from "../router.js";

// Known slugs that get pre-rendered at build time.
// Unknown slugs fall through to the live handler thanks to passthrough: true.
const knownGuides: Record<string, string> = {
  routing: "Routing Guide",
  caching: "Caching Guide",
};

export const GuidesDetail = createPrerenderHandler<{ slug: string }>(
  async () => Object.keys(knownGuides).map((slug) => ({ slug })),
  async (ctx) => {
    const title = knownGuides[ctx.params.slug] ?? `Guide: ${ctx.params.slug}`;
    const renderedAt = new Date().toISOString();

    return (
      <div data-testid="guide-detail">
        <h1 data-testid="guide-title">{title}</h1>
        <p data-testid="guide-rendered-at">Rendered at: {renderedAt}</p>
        <p data-testid="guide-slug">Slug: {ctx.params.slug}</p>
        <nav style={{ marginTop: "1rem" }}>
          <Link
            to={reverse("guides.detail", { slug: "routing" })}
            data-testid="guide-link-routing"
          >
            Routing
          </Link>
          {" | "}
          <Link
            to={reverse("guides.detail", { slug: "caching" })}
            data-testid="guide-link-caching"
          >
            Caching
          </Link>
          {" | "}
          <Link
            to={reverse("guides.detail", { slug: "dynamic-test" })}
            data-testid="guide-link-dynamic"
          >
            Dynamic Test
          </Link>
        </nav>
      </div>
    );
  },
  { passthrough: true },
);
