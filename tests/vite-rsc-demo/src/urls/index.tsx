import { urls, Meta } from "@rangojs/router";
import { GtmBootstrap } from "../handles/gtm.js";
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
export const urlpatterns = urls(({ path, include, parallel }) => [
  // The GTM bootstrap and the default document title are pushed by UI-less parallel
  // slots (@gtm, @meta), not a layout handler. There is NO inner layout: RootLayout
  // (the createRouter `document`) already wraps every route in <html><body>, so a
  // pass-through layout(<Outlet/>) would only add a redundant segment. These slots
  // sit at the route ROOT, so they apply to EVERY route (including the standalone
  // /errors/unhandled). @gtm pushes the GTM bootstrap Script, rendered by <Scripts/>
  // in RootLayout's <head> with the request nonce; a route OVERRIDES it by reusing
  // the "gtm" id (see /gtm). @meta sets the SOLE managed <title>, so document.title
  // is correct at parse time when the bootstrap reads page_title. A child route's
  // own ctx.use(Script)/ctx.use(Meta) wins (root -> child, last-push-wins).
  parallel({
    "@gtm": GtmBootstrap,
    "@meta": (ctx) => {
      ctx.use(Meta)({ title: "RSC Router Demo" });
      return null;
    },
  }),

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

  // Unhandled error route - no error boundary in its parent chain (it deliberately
  // renders standalone to demonstrate an unhandled error escaping boundaries). It
  // now ALSO receives the @gtm/@meta root slots above, since they apply at the root.
  include("", unhandledErrorPattern, { name: "" }),
]);
