import { urls } from "@rangojs/router";
import {
  DashboardLayout,
  DashboardIndexPage,
  DashboardSettingsPage,
  DashboardSidebar,
  DashboardFooter,
} from "../pages/dashboard.js";

export const dashboardPatterns = urls(
  ({ path, layout, parallel, middleware, revalidate }) => [
    layout(<DashboardLayout />, () => [
      middleware(
        (ctx, next) => {
          console.log("[Dashboard Middleware] Rate limit check");
          const requestCount = ctx.get("requestCount") || 0;
          ctx.set("requestCount", requestCount + 1);
          if (requestCount > 100) {
            console.warn("[Dashboard Middleware] Rate limit exceeded");
          } else {
            console.log(
              `[Dashboard Middleware] Request ${requestCount + 1}/100`,
            );
          }
          next();
        },
        (ctx, next) => {
          console.log(`[Dashboard Middleware] Analytics: ${ctx.pathname}`);
          next();
        },
      ),
      revalidate(({ currentUrl, nextUrl }) => {
        console.log("[Dashboard] Context-based revalidation");
        return currentUrl.search !== nextUrl.search;
      }),

      path("/", DashboardIndexPage, { name: "index" }, () => [
        parallel({
          "@sidebar": DashboardSidebar,
          "@footer": DashboardFooter,
        }),
      ]),

      path("/settings", DashboardSettingsPage, { name: "settings" }, () => [
        middleware((ctx, next) => {
          console.log("[Dashboard Middleware] Settings validation");
          next();
        }),
      ]),
    ]),
  ],
);
