import { urls } from "@rangojs/router";
import {
  MiddlewareDemoLayout,
  MiddlewareIndexPage,
  MiddlewareDashboardPage,
  MiddlewareTimedPage,
  MiddlewareUserPage,
  MiddlewareApiPage,
  globalMiddleware,
  dashboardMiddleware,
  timedMiddleware,
  userMiddleware,
  apiMiddleware,
} from "../pages/middleware.js";

export const middlewarePatterns = urls(({ path, layout, middleware }) => [
  layout(<MiddlewareDemoLayout />, () => [
    middleware(...globalMiddleware),

    path("/", MiddlewareIndexPage, { name: "index" }),
    path("/dashboard", MiddlewareDashboardPage, { name: "dashboard" }, () => [
      middleware(...dashboardMiddleware),
    ]),
    path("/timed", MiddlewareTimedPage, { name: "timed" }, () => [
      middleware(...timedMiddleware),
    ]),
    path("/user/:userId", MiddlewareUserPage, { name: "user" }, () => [
      middleware(...userMiddleware),
    ]),
    path("/api/data", MiddlewareApiPage, { name: "api" }, () => [
      middleware(...apiMiddleware),
    ]),
  ]),
]);
