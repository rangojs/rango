import { Meta } from "@rangojs/router/server";
import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

const featuresDetail: Record<string, { name: string; description: string; details: string }> = {
  "server-components": {
    name: "Server Components",
    description: "React components that render on the server",
    details: "Server Components allow you to write UI that can be rendered and optionally cached on the server. They run only on the server, reducing bundle size and improving performance.",
  },
  "server-actions": {
    name: "Server Actions",
    description: "Functions that run on the server",
    details: "Server Actions are async functions that run on the server. They can be called from Client Components and provide a simple way to handle form submissions and mutations.",
  },
  streaming: {
    name: "Streaming",
    description: "Progressive rendering with Suspense",
    details: "RSC streaming allows you to progressively render UI as data becomes available. Combined with Suspense boundaries, you can show loading states while content streams in.",
  },
};

export async function FeatureDetailPage(ctx: HandlerContext<{ slug: string }>) {
  const slug = ctx.params.slug;
  const feature = featuresDetail[slug];

  if (!feature) {
    throw new Error(`Feature not found: ${slug}`);
  }

  const meta = ctx.use(Meta);
  meta({ title: `${feature.name} - RSC Router Cloudflare` });
  meta({ name: "description", content: feature.description });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({ label: feature.name, href: `/features/${slug}` });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  return (
    <main data-testid="feature-page">
      <h1 data-testid="feature-title">{feature.name}</h1>
      <p data-testid="feature-description" style={{ marginBottom: "1rem", color: "#666" }}>
        {feature.description}
      </p>
      <p data-testid="feature-details">{feature.details}</p>
    </main>
  );
}
