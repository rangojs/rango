import type { MiddlewareFn } from "@rangojs/router";
import { redirect } from "@rangojs/router/server";

/**
 * Auth middleware - redirects if not logged in
 */
export const authMiddleware: MiddlewareFn = (ctx, next) => {
  const loggedIn = ctx.url.searchParams.get("logged_in") === "true";

  if (!loggedIn) {
    console.log("[Protected Middleware] Not logged in, redirecting");
    redirect("/");
    return;
  }

  console.log("[Protected Middleware] Authenticated, proceeding");
  ctx.set("user", { id: "user-123", name: "Demo User" });
  next();
};
