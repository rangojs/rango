import type { Middleware } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

/**
 * Observable evidence for the layout -> middleware -> include(clientUrls)
 * semantics (docs/client-urls.md "Outer layouts and middleware across group
 * navigations"): the middleware stamps a monotonic counter header on EVERY
 * canonical request it wraps, and the outer layout stamps its run count into
 * the DOM. The e2e asserts the header advances on every within-group
 * navigation (held-loader tab switches included) while the DOM stamp holds —
 * middleware re-runs per request, the layout handler does not.
 */
let middlewareRuns = 0;
let layoutRuns = 0;

export const clientShopGuardMiddleware: Middleware = async (ctx, next) => {
  middlewareRuns += 1;
  ctx.header("x-client-shop-mw", String(middlewareRuns));
  return next();
};

export function ClientShopOuterLayout(): React.ReactElement {
  layoutRuns += 1;
  return (
    <div data-testid="client-shop-outer" data-stamp={String(layoutRuns)}>
      <Outlet />
    </div>
  );
}
