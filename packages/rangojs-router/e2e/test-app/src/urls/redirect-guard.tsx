import { urls, redirect } from "@rangojs/router";

/**
 * Open-redirect guard e2e fixtures.
 *
 * A route-middleware redirect whose target comes from the request (`?to=`) so a
 * test can drive every case through the real server guard via raw HTTP, with no
 * browser navigation to an off-host target required:
 *   - same-origin / relative  -> passes through
 *   - cross-origin / protocol-relative (no opt-in) -> Location rewritten to root
 *   - `?ext=1` (redirect(url, { external: true })) -> off-host target allowed
 */
export const redirectGuardPatterns = urls(({ path, middleware }) => [
  path(
    "/go",
    () => (
      <div data-testid="redirect-guard-page">
        <h1 data-testid="redirect-guard-title">Redirect Guard</h1>
      </div>
    ),
    { name: "go" },
    () => [
      middleware((ctx, next) => {
        const to = ctx.searchParams.get("to");
        if (!to) return next();
        const external = ctx.searchParams.get("ext") === "1";
        return external ? redirect(to, { external: true }) : redirect(to);
      }),
    ],
  ),
]);
