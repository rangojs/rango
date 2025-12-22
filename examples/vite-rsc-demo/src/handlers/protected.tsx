import { map, redirect } from "rsc-router/server";
import type { protectedRoutes } from "../routes.js";

/**
 * Protected handlers - demonstrates middleware short-circuit
 * Array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof protectedRoutes>(({ route, layout, middleware }) => [
  // Global auth middleware
  middleware((ctx, next) => {
    const isLoggedIn = ctx.searchParams.get("logged_in") === "true";

    if (!isLoggedIn) {
      console.log("[Protected] Not logged in - soft redirect");
      return redirect("/");
    }

    console.log("[Protected] Authenticated");
    next();
  }),

  route("index", (ctx) => (
    <div>
      <h2>Protected Area</h2>
      <p>You are authenticated!</p>
      <p>URL: {ctx.pathname}</p>
      <p><a href="/">← Back to home</a></p>
    </div>
  )),

  route("dashboard", () => (
    <div>
      <h2>Dashboard</h2>
      <p>Protected dashboard content</p>
    </div>
  )),

  route("profile", (ctx) => (
    <div>
      <h2>Profile: {ctx.params.username}</h2>
      <p>Protected profile page</p>
    </div>
  )),
]);
