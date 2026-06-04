import { Link } from "@rangojs/router/client";
import { FeatureLocationState } from "../location-states.js";

const features = {
  loaders: { name: "Loaders", description: "Fresh data every request" },
  actions: { name: "Actions", description: "Server mutations" },
  handles: { name: "Handles", description: "Cross-segment data" },
};

export function HomePage() {
  return (
    <div data-testid="home-page">
      <h1 data-testid="home-title">Welcome</h1>
      <p data-testid="home-description">
        This app verifies @rangojs/router works without TypeScript.
      </p>
      <ul data-testid="feature-links">
        {Object.entries(features).map(([slug, feature]) => (
          <li key={slug}>
            {/* state[] attaches location state read by the loading fallback. */}
            <Link
              to={`/features/${slug}`}
              state={[
                FeatureLocationState({
                  name: feature.name,
                  description: feature.description,
                }),
              ]}
              data-testid={`feature-link-${slug}`}
            >
              {feature.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
