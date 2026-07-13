import { Meta, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { FeatureLocationState } from "../location-states.js";

const features = [
  {
    slug: "server-components",
    name: "Server Components",
    description: "React components that render on the server",
  },
  {
    slug: "server-actions",
    name: "Server Actions",
    description: "Functions that run on the server",
  },
  {
    slug: "streaming",
    name: "Streaming",
    description: "Progressive rendering with Suspense",
  },
];

export function HomePage(ctx: HandlerContext) {
  if (ctx.searchParams.has("ssr-setup-redirect")) {
    return redirect("/about");
  }

  const meta = ctx.use(Meta);
  meta({ title: "Home - RSC Router Cloudflare" });
  meta({
    name: "description",
    content: "A minimal RSC Router example running on Cloudflare Workers",
  });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });

  return (
    <main data-testid="home-page">
      <h1 data-testid="home-title">Welcome to RSC Router</h1>
      <p>This is a minimal example running on Cloudflare Workers.</p>
      <a
        href="/about?plain-prefetch=1"
        data-prefetch="true"
        data-testid="plain-prefetch-link"
      >
        Plain anchor prefetch fixture
      </a>
      <p>It demonstrates:</p>
      <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
        <li>React Server Components with RSC streaming</li>
        <li>Client-side navigation with partial rendering</li>
        <li>Server Actions (see the Counter page)</li>
        <li>Cloudflare Workers deployment</li>
      </ul>
      <h2 style={{ marginTop: "2rem" }}>Features</h2>
      <p style={{ marginBottom: "1rem" }}>
        Click a feature to see details (with location state for instant loading
        preview):
      </p>
      <ul style={{ marginLeft: "1.5rem" }} data-testid="feature-links">
        {features.map((feature) => (
          <li key={feature.slug} style={{ marginBottom: "0.5rem" }}>
            <Link
              to={`/features/${feature.slug}`}
              state={[
                FeatureLocationState({
                  name: feature.name,
                  description: feature.description,
                }),
              ]}
              data-testid={`feature-link-${feature.slug}`}
              style={{ color: "#0070f3", textDecoration: "none" }}
            >
              {feature.name}
            </Link>
            {" - "}
            <span style={{ color: "#666" }}>{feature.description}</span>
          </li>
        ))}
      </ul>
      {/* #622 follow-up: prefetch-transition regression entry points. */}
      <ul style={{ marginLeft: "1.5rem" }} data-testid="pt-links">
        <li>
          {/* Plain link (no prefetch) for the cold-nav case. */}
          <Link to="/pt-slow" data-testid="pt-slow-cold-link">
            /pt-slow (cold)
          </Link>
        </li>
        <li>
          <Link
            to="/pt-slow"
            data-testid="pt-slow-prefetch-link"
            prefetch="hover"
          >
            /pt-slow (prefetch=hover)
          </Link>
        </li>
        <li>
          <Link to="/pt-layout/from" data-testid="pt-layout-entry-link">
            /pt-layout/from (client-mount-suspense regression)
          </Link>
        </li>
      </ul>
    </main>
  );
}
