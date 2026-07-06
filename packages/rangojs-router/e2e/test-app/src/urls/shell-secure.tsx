import { urls, Meta } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import type { HandlerContext, Middleware } from "@rangojs/router";
import { ShellPriceLoader } from "./shell-cache.defs.js";
import { ShellCachePrice } from "../components/ShellCachePrice.js";

// PPR guarding + scope-fidelity fixtures (docs/design/ppr-shell-resume.md).
//
// The PPR COMMIT POINT sits after the WHOLE middleware chain — the global
// router.use() chain AND route DSL middleware() both wrap the render pass — so
// any rejection wins before a single shell byte:
//   - /shell-secure sits behind a GLOBAL auth middleware (router.tsx mounts
//     shellSecureAuthMiddleware on /shell-secure/*): an unauthorized request gets
//     its 401 with ZERO shell bytes, even when the shell is warm.
//   - /shell-secure-dsl carries the SAME rejection as ROUTE DSL middleware()
//     inside urls(): the commit point is after route middleware too.
//
// Scope fidelity: the auth middleware ctx.set()s a variable the layout renders.
// The background capture inherits the triggering request's post-middleware
// context (derived Object.create), so the captured prelude carries the
// middleware-derived value without middleware ever re-running during capture —
// the run counter (exposed via /shell-secure-runs, OUTSIDE the auth mount) must
// advance by exactly one per HTTP request, captures included.

let secureMwRuns = 0;

/** Global auth middleware for /shell-secure/* (mounted in router.tsx). */
export const shellSecureAuthMiddleware: Middleware = async (ctx, next) => {
  secureMwRuns += 1;
  if (ctx.request.headers.get("x-shell-auth") !== "yes") {
    return new Response("unauthorized", { status: 401 });
  }
  ctx.set("shellMwVar", "MW-SCOPE-VALUE");
  return next();
};

/** Route DSL middleware for /shell-secure-dsl (attached via middleware() below). */
const shellSecureDslMiddleware: Middleware = async (ctx, next) => {
  if (ctx.request.headers.get("x-shell-auth") !== "yes") {
    return new Response("unauthorized-dsl", { status: 401 });
  }
  ctx.set("shellMwVar", "MW-SCOPE-VALUE");
  return next();
};

function ShellSecureLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Secure" });
  // Scope fidelity: middleware-derived state, rendered as SHELL material.
  const mwVar = ctx.get("shellMwVar") ?? "none";
  return (
    <main data-testid="shell-secure-page">
      <h1 data-testid="shell-secure-header">Shell Secure Demo</h1>
      <span data-testid="shell-secure-mw-var">{mwVar}</span>
      <Outlet />
    </main>
  );
}

function ShellSecurePricePage() {
  return <ShellCachePrice loader={ShellPriceLoader} />;
}

export const shellSecurePatterns = urls(
  ({ path, layout, loader, loading, middleware }) => [
    layout(ShellSecureLayout, () => [
      path(
        "/shell-secure",
        ShellSecurePricePage,
        { name: "shellSecure", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="shell-secure-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
    layout(ShellSecureLayout, () => [
      middleware(shellSecureDslMiddleware),
      path(
        "/shell-secure-dsl",
        ShellSecurePricePage,
        { name: "shellSecureDsl", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="shell-secure-dsl-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
    // Middleware-run counter, OUTSIDE the /shell-secure/* auth mount (different
    // first path segment), so reading it never runs the auth middleware.
    path.text("/shell-secure-runs", () => String(secureMwRuns), {
      name: "shellSecureRuns",
    }),
  ],
);
