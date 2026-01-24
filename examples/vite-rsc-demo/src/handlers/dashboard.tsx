import { map } from "@ivogt/rsc-router/server";
import type { dashboardRoutes } from "../routes.js";
import { DashboardLayout } from "../layouts/DashboardLayout.js";

/**
 * Dashboard handlers with parallel routes
 * Array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof dashboardRoutes>(({ route, layout, middleware, parallel, revalidate }) => [
  layout(<DashboardLayout />, () => [
    // Global middleware
    middleware(
      (ctx, next) => {
        console.log("[Dashboard Middleware] Rate limit check");
        const requestCount = ctx.get('requestCount') || 0;
        ctx.set('requestCount', requestCount + 1);

        if (requestCount > 100) {
          console.warn("[Dashboard Middleware] Rate limit exceeded");
        } else {
          console.log(`[Dashboard Middleware] Request ${requestCount + 1}/100`);
        }
        next();
      },
      (ctx, next) => {
        console.log(`[Dashboard Middleware] Analytics: ${ctx.pathname}`);
        next();
      }
    ),

    // Global revalidation
    revalidate(({ currentUrl, nextUrl }) => {
      console.log("[Dashboard] Context-based revalidation");
      return currentUrl.search !== nextUrl.search;
    }),

    // Index with parallels
    route("index", () => (
      <div style={{ background: "#f0f9ff", padding: "2rem", borderRadius: "8px" }}>
        <p className="segment-id">Segment: Dashboard Index</p>
        <h1>Dashboard Home</h1>
        <p>Welcome to your dashboard</p>
      </div>
    ), () => [
      parallel({
        "@sidebar": () => (
          <div style={{ background: "#fff3cd", padding: "1rem", borderRadius: "8px" }}>
            <p className="segment-id">Segment: @sidebar</p>
            <h4>Dashboard Sidebar</h4>
            <ul>
              <li>Overview</li>
              <li>Analytics</li>
              <li><a href="/dashboard/settings">Settings</a></li>
            </ul>
          </div>
        ),
        "@footer": () => (
          <div style={{ background: "#e8f4f8", padding: "1rem", marginTop: "2rem", borderRadius: "8px" }}>
            <p className="segment-id">Segment: @footer</p>
            <p style={{ fontSize: "0.85rem" }}>Dashboard footer</p>
          </div>
        ),
      }),
    ]),

    // Settings with middleware
    route("settings", () => (
      <div style={{ background: "#f0f9ff", padding: "2rem", borderRadius: "8px" }}>
        <p className="segment-id">Segment: Dashboard Settings</p>
        <h1>Dashboard Settings</h1>
        <p>Configure your dashboard</p>
        <p style={{ marginTop: "1rem" }}>
          <a href="/dashboard">← Back to Dashboard</a>
        </p>
      </div>
    ), () => [
      middleware((ctx, next) => {
        console.log("[Dashboard Middleware] Settings validation");
        next();
      }),
    ]),
  ]),
]);
