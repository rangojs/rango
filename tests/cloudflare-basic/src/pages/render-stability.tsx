import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { RenderStabilityPage } from "../components/RenderStability.js";

/**
 * Hook render-stability fixture for the Cloudflare app. Mirrors the e2e test-app
 * page: renders memoized hook probes whose render/commit counts land on
 * window.__RANGO_RENDERS__. The `:id` segment lets the e2e drive a same-depth
 * param swap; search is added via the in-page controls.
 */
export async function RenderStabilityRoute(
  ctx: HandlerContext<{ id: string }>,
) {
  const meta = ctx.use(Meta);
  meta({ title: "Hook Render Stability" });

  return (
    <div data-testid="render-stability-route">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="render-stability-title">Hook Render Stability</h1>
      <RenderStabilityPage />
    </div>
  );
}
