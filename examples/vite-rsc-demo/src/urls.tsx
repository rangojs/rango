import { urls } from "@rangojs/router/server";
import { Outlet } from "@rangojs/router/client";

// Page imports
import { HomePage } from "./pages/home.js";
import { AboutPage } from "./pages/about.js";
import {
  DashboardLayout,
  DashboardIndexPage,
  DashboardSettingsPage,
  DashboardSidebar,
  DashboardFooter,
} from "./pages/dashboard.js";
import {
  AdminIndexPage,
  AdminUsersPage,
  AdminUserPage,
  AdminSettingsPage,
  globalRevalidation,
  userRevalidation,
  settingsRevalidation,
} from "./pages/admin.js";
import {
  ProtectedIndexPage,
  ProtectedDashboardPage,
  ProtectedProfilePage,
} from "./pages/protected.js";
import {
  TodosLayout,
  TodosIndexPage,
  TodoDetailPage,
  todosErrorBoundary,
} from "./pages/todos.js";
import {
  ErrorsLayout,
  ErrorsIndexPage,
  ErrorsLoaderErrorPage,
  ErrorsNotFoundLoaderPage,
  ErrorsClientErrorPage,
  errorsErrorBoundary,
  errorsNotFoundBoundary,
} from "./pages/errors.js";
import {
  KanbanLayout,
  KanbanIndexPage,
  KanbanCardPage,
  kanbanErrorBoundary,
} from "./pages/kanban.js";
import {
  LoadersDemoLayout,
  LoadersIndexPage,
  LoadersStatsPage,
} from "./pages/loaders-demo.js";
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
} from "./pages/middleware.js";
import {
  BlogLayout,
  BlogIndexPage,
  BlogPostPage,
  blogLoggerMiddleware,
  postRevalidation,
} from "./pages/blog.js";

/**
 * URL patterns - Django-style routing API
 *
 * This replaces the old routes.ts + handlers/ pattern with a unified
 * urls() API that defines routes and their handlers together.
 */
export const urlpatterns = urls(
  ({
    path,
    layout,
    parallel,
    loader,
    loading,
    cache,
    middleware,
    revalidate,
    errorBoundary,
    notFoundBoundary,
  }) => [
    // Home route
    path("/", HomePage, { name: "home.index" }),

    // About route
    path("/about", AboutPage, { name: "about.index" }),

    // Blog routes with sidebar
    layout(BlogLayout, () => [
      middleware(...blogLoggerMiddleware),
      cache({ ttl: 600000000 }, () => [
        path("/blog", BlogIndexPage, { name: "blog.index" }),
        path("/blog/:slug", BlogPostPage, { name: "blog.post" }, () => [
          revalidate(postRevalidation),
        ]),
      ]),
    ]),

    // Dashboard routes with parallel slots
    layout(<DashboardLayout />, () => [
      middleware(
        (ctx, next) => {
          console.log("[Dashboard Middleware] Rate limit check");
          const requestCount = ctx.get("requestCount") || 0;
          ctx.set("requestCount", requestCount + 1);
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
      revalidate(({ currentUrl, nextUrl }) => {
        console.log("[Dashboard] Context-based revalidation");
        return currentUrl.search !== nextUrl.search;
      }),

      path("/dashboard", DashboardIndexPage, { name: "dashboard.index" }, () => [
        parallel({
          "@sidebar": DashboardSidebar,
          "@footer": DashboardFooter,
        }),
      ]),

      path("/dashboard/settings", DashboardSettingsPage, { name: "dashboard.settings" }, () => [
        middleware((ctx, next) => {
          console.log("[Dashboard Middleware] Settings validation");
          next();
        }),
      ]),
    ]),

    // Admin routes - wrapped in passthrough layout for global revalidation
    layout(<Outlet />, () => [
      revalidate(globalRevalidation),
      path("/admin", AdminIndexPage, { name: "admin.index" }),
      path("/admin/users", AdminUsersPage, { name: "admin.users" }),
      path("/admin/users/:id", AdminUserPage, { name: "admin.user" }, () => [
        revalidate(userRevalidation),
      ]),
      path("/admin/settings", AdminSettingsPage, { name: "admin.settings" }, () => [
        revalidate(settingsRevalidation),
      ]),
    ]),

    // Protected routes - wrapped in passthrough layout for middleware
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
      path("/protected", ProtectedIndexPage, { name: "protected.index" }),
      path("/protected/dashboard", ProtectedDashboardPage, { name: "protected.dashboard" }),
      path("/protected/profile/:username", ProtectedProfilePage, { name: "protected.profile" }),
    ]),

    // Todos routes - wrapped in passthrough layout for error boundary
    layout(<Outlet />, () => [
      errorBoundary(todosErrorBoundary),
      layout(<TodosLayout />, () => [
        path("/todos", TodosIndexPage, { name: "todos.index" }, () => [
          revalidate(() => false),
        ]),
        path("/todos/:id", TodoDetailPage, { name: "todos.detail" }, () => [
          revalidate(() => false),
        ]),
      ]),
    ]),

    // Unhandled error route - NO error boundary in parent chain
    // Tests root ErrorBoundary added by renderSegments
    path(
      "/errors/unhandled",
      () => {
        throw new Error("This error is NOT caught by any route error boundary - it bubbles to root");
      },
      { name: "errors.unhandled" }
    ),

    // Error routes - demonstrates error boundary handling
    layout(<ErrorsLayout />, () => [
      errorBoundary(errorsErrorBoundary),
      notFoundBoundary(errorsNotFoundBoundary),

      path("/errors", ErrorsIndexPage, { name: "errors.index" }),
      path(
        "/errors/throw",
        () => {
          throw new Error("Simulated handler error - something went wrong!");
        },
        { name: "errors.throwError" }
      ),
      path("/errors/loader-error", ErrorsLoaderErrorPage, { name: "errors.loaderError" }),
      path("/errors/not-found", ErrorsNotFoundLoaderPage, { name: "errors.notFound" }),
      path("/errors/not-found-loader", ErrorsNotFoundLoaderPage, { name: "errors.notFoundLoader" }),
      path("/errors/client-error", ErrorsClientErrorPage, { name: "errors.clientError" }),
    ]),

    // Kanban routes - wrapped in passthrough layout for error boundary
    layout(<Outlet />, () => [
      errorBoundary(kanbanErrorBoundary),
      layout(<KanbanLayout />, () => [
        path("/kanban", KanbanIndexPage, { name: "kanban.index" }),
        path("/kanban/card/:cardId", KanbanCardPage, { name: "kanban.card" }),
      ]),
    ]),

    // Loaders demo routes
    layout(<LoadersDemoLayout />, () => [
      path("/loaders", LoadersIndexPage, { name: "loaders.index" }),
      path("/loaders/stats", LoadersStatsPage, { name: "loaders.stats" }),
    ]),

    // Middleware demo routes
    layout(<MiddlewareDemoLayout />, () => [
      middleware(...globalMiddleware),

      path("/middleware", MiddlewareIndexPage, { name: "middleware.index" }),
      path("/middleware/dashboard", MiddlewareDashboardPage, { name: "middleware.dashboard" }, () => [
        middleware(...dashboardMiddleware),
      ]),
      path("/middleware/timed", MiddlewareTimedPage, { name: "middleware.timed" }, () => [
        middleware(...timedMiddleware),
      ]),
      path("/middleware/user/:userId", MiddlewareUserPage, { name: "middleware.user" }, () => [
        middleware(...userMiddleware),
      ]),
      path("/middleware/api/data", MiddlewareApiPage, { name: "middleware.api" }, () => [
        middleware(...apiMiddleware),
      ]),
    ]),
  ]
);
