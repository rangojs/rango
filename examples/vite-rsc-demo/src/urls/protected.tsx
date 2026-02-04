import { urls } from "@rangojs/router/server";
import { Outlet } from "@rangojs/router/client";
import {
  ProtectedIndexPage,
  ProtectedDashboardPage,
  ProtectedProfilePage,
} from "../pages/protected.js";

export const protectedPatterns = urls(({ path, layout, middleware }) => [
  // Passthrough layout for middleware
  layout(<Outlet />, () => [
    middleware((ctx, next) => {
      const loggedIn = ctx.url.searchParams.get("logged_in") === "true";
      if (loggedIn) {
        console.log("[Protected Middleware] Authenticated, proceeding");
        ctx.set("user", { id: "user-123", name: "Demo User" });
      } else {
        console.log("[Protected Middleware] Not logged in (redirect disabled for build compatibility)");
      }
      next();
    }),
    path("/", ProtectedIndexPage, { name: "index" }),
    path("/dashboard", ProtectedDashboardPage, { name: "dashboard" }),
    path("/profile/:username", ProtectedProfilePage, { name: "profile" }),
  ]),
]);
