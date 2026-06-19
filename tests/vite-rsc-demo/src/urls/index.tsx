import { urls, Meta } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { Gtm, DEFAULT_GTM_ID } from "../handles/gtm.js";
import { HomePage } from "../pages/home.js";
import { AboutPage } from "../pages/about.js";
import { PrefetchTestPage } from "../pages/prefetch-test.js";

// Import URL patterns from separate modules
import { blogPatterns } from "./blog.js";
import { dashboardPatterns } from "./dashboard.js";
import { adminPatterns } from "./admin.js";
import { protectedPatterns } from "./protected.js";
import { todosPatterns } from "./todos.js";
import { errorsPatterns, unhandledErrorPattern } from "./errors.js";
import { kanbanPatterns } from "./kanban.js";
import { loadersPatterns } from "./loaders.js";
import { middlewarePatterns } from "./middleware.js";
import { shopPatterns } from "./shop.js";
import { magazinePatterns } from "./magazine.js";
import { compositionPatterns } from "./composition-test.js";
import { refreshDemoPatterns } from "./refresh-demo.js";
import { gtmDemoPatterns } from "./gtm.js";

/**
 * URL patterns - Django-style routing API
 *
 * Routes are organized into separate modules and composed using include().
 * Each module exports a urls() result that defines routes with relative paths.
 * The include() helper adds URL prefix and optional name prefix.
 */
export const urlpatterns = urls(({ path, layout, include }) => [
  // GTM layout: a transparent wrapper (renders only its children via <Outlet />)
  // whose handler runs on every matched route and pushes the GTM container id +
  // page path into the Gtm handle. <GtmScript> in the document head reads the
  // merged value via useHandle(Gtm) and injects the nonced GTM scripts; nested
  // routes can push extra page tagging on top (e.g. /gtm adds content_group).
  layout(
    (ctx) => {
      // Container id is a build constant (prerender-safe: ctx.env is unavailable
      // during build-time pre-rendering). page.path is per-request (pathname +
      // search, matching the soft-nav page_view); on a prerendered route it is
      // captured into the stored Flight payload.
      ctx.use(Gtm)({
        containerId: DEFAULT_GTM_ID,
        page: { path: ctx.url.pathname + ctx.url.search },
      });
      // Default document title via the Meta handle (overridden per route). This
      // is the SOLE managed <title>, so document.title is correct at parse time
      // when the inline GTM bootstrap reads it for the first page_view's
      // page_title (no competing manual <title> in RootLayout).
      ctx.use(Meta)({ title: "RSC Router Demo" });
      return <Outlet />;
    },
    () => [
      // Root routes
      path(
        "/",
        (ctx) => {
          ctx.use(Meta)({ title: "Home" });
          return <HomePage />;
        },
        { name: "home.index" },
      ),
      path(
        "/about",
        (ctx) => {
          ctx.use(Meta)({ title: "About" });
          return <AboutPage />;
        },
        { name: "about.index" },
      ),
      path("/prefetch-test", PrefetchTestPage, { name: "prefetch-test" }),

      // Include patterns from separate modules
      include("/blog", blogPatterns, { name: "blog" }),
      include("/dashboard", dashboardPatterns, { name: "dashboard" }),
      include("/admin", adminPatterns, { name: "admin" }),
      include("/protected", protectedPatterns, { name: "protected" }),
      include("/todos", todosPatterns, { name: "todos" }),
      include("/errors", errorsPatterns, { name: "errors" }),
      include("/kanban", kanbanPatterns, { name: "kanban" }),
      include("/loaders", loadersPatterns, { name: "loaders" }),
      include("/refresh", refreshDemoPatterns, { name: "refresh" }),
      include("/middleware", middlewarePatterns, { name: "middleware" }),
      include("/shop", shopPatterns, { name: "shop" }),
      include("/magazine", magazinePatterns, { name: "magazine" }),
      include("/composition", compositionPatterns, { name: "composition" }),
      include("/gtm", gtmDemoPatterns, { name: "gtm" }),
    ],
  ),

  // Unhandled error route - outside of any error boundary AND outside the GTM
  // layout (it deliberately renders standalone).
  include("", unhandledErrorPattern, { name: "" }),
]);
