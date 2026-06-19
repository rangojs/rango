import { urls, Meta, Script } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { DEFAULT_GTM_ID, generateGtmInit } from "../handles/gtm.js";
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
  // Root layout. Pushes the GTM bootstrap into the built-in Script handle (the
  // single inline snippet that inits dataLayer, fires the first page_view, and
  // injects gtm.js); <Scripts/> in RootLayout's <head> renders it with the
  // request nonce. A route can OVERRIDE this by reusing the "gtm" id to bake
  // per-route tagging into the first page_view (see /gtm). Also sets the default
  // document title via Meta — the SOLE managed <title>, so document.title is
  // correct at parse time when the bootstrap reads it for page_title.
  layout(
    (ctx) => {
      ctx.use(Script)({ id: "gtm", children: generateGtmInit(DEFAULT_GTM_ID) });
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
