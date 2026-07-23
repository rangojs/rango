import { urls } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { RenderStabilityPage } from "../components/RenderStability.js";

/**
 * Hook render-stability fixture. The `:id` segment lets the e2e drive a
 * same-depth param swap; search is added via the in-page controls. The page
 * renders memoized hook probes whose render/commit counts land on
 * window.__RANGO_RENDERS__.
 */
export const RenderStabilityHandler: Handler<"renderStability"> = () => (
  <div data-testid="render-stability-route">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="render-stability-title">Hook Render Stability</h1>
    <RenderStabilityPage />
  </div>
);

export const renderStabilityPatterns = urls(({ path }) => [
  path("/render-stability/p/:id", RenderStabilityHandler, {
    name: "renderStability",
  }),
]);
