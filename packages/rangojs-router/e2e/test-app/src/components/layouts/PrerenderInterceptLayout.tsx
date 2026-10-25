import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { PrerenderInterceptLayoutProbe } from "../../urls/prerender-intercept.client.js";
import { PrerenderInterceptLayoutStamp } from "../../urls/prerender-intercept.defs.js";

// The render stamp, shown and pushed as a handle value, tells which render
// the client holds: a live one, or the bake's (build time in production, the
// dev store's render in dev).
export function PrerenderInterceptLayout(ctx: HandlerContext) {
  const renderTime = new Date().toISOString();
  ctx.use(PrerenderInterceptLayoutStamp)(renderTime);
  return (
    <div data-testid="prerender-intercept-layout">
      <p data-testid="pri-layout-render-time">{renderTime}</p>
      <PrerenderInterceptLayoutProbe />
      <Outlet />
      <Outlet name="@modal" />
      <Outlet name="@drawer" />
    </div>
  );
}
