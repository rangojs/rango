/**
 * /app group: an app-shaped route slice for representative load.
 *
 * - layout with a live loader (AppShellLoader) wrapping everything
 * - /dashboard/:section — two more loaders in parallel + client consumers
 * - /cached/:bucket — a cache() segment boundary (CFCacheStore hit/miss)
 * - /feedback — server-action form, PE-postable by the bench
 *
 * Loaded as an async include (own worker chunk) like the other groups.
 */
import { urls } from "@rangojs/router";
import { ActivityLoader, AppShellLoader, StatsLoader } from "./app-loaders.js";
import { acceptLanguageMiddleware } from "./middleware.js";
import {
  AppLayout,
  CachedPage,
  DashboardPage,
  FeedbackPage,
} from "./pages/app-pages.js";

export const appPatterns = urls(
  ({ path, layout, loader, loading, cache, middleware }) => [
    middleware(acceptLanguageMiddleware),

    layout(<AppLayout />, () => [
      loader(AppShellLoader),

      path("/dashboard/:section", DashboardPage, { name: "dashboard" }, () => [
        loader(StatsLoader),
        loader(ActivityLoader),
        loading(<p data-testid="dashboard-loading">Loading dashboard…</p>),
      ]),

      cache({ ttl: 300 }, () => [
        path("/cached/:bucket", CachedPage, { name: "cached" }),
      ]),

      path("/feedback", FeedbackPage, { name: "feedback" }),
    ]),
  ],
);

export default appPatterns;
