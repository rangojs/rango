import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles.js";

const features = {
  loaders: { name: "Loaders", description: "Fresh data every request" },
  actions: { name: "Actions", description: "Server mutations" },
  handles: { name: "Handles", description: "Cross-segment data" },
};

// Handler receives the request context directly so it can push breadcrumb
// items (handles) and read params. A small delay makes the loading fallback
// observable on client navigation.
export async function FeatureDetailPage(ctx) {
  const slug = ctx.params.slug;
  const feature = features[slug];
  if (!feature) throw new Error(`Feature not found: ${slug}`);

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({ label: feature.name, href: `/features/${slug}` });

  await new Promise((resolve) => setTimeout(resolve, 700));

  return (
    <div data-testid="feature-page">
      <h1 data-testid="feature-title">{feature.name}</h1>
      <p data-testid="feature-description">{feature.description}</p>
      <nav data-testid="feature-siblings">
        {Object.keys(features).map((s) => (
          <Link key={s} to={`/features/${s}`} data-testid={`feature-nav-${s}`}>
            {features[s].name}
          </Link>
        ))}
      </nav>
    </div>
  );
}
