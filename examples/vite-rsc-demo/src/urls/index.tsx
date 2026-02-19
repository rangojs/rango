import { urls } from "@rangojs/router";
import { HomePage } from "../pages/home.js";
import { AboutPage } from "../pages/about.js";

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

/**
 * URL patterns - Django-style routing API
 *
 * Routes are organized into separate modules and composed using include().
 * Each module exports a urls() result that defines routes with relative paths.
 * The include() helper adds URL prefix and optional name prefix.
 */
export const urlpatterns = urls(({ path, include }) => [
  // Root routes
  path("/", HomePage, { name: "home.index" }),
  path("/about", AboutPage, { name: "about.index" }),

  // Include patterns from separate modules
  include("/blog", blogPatterns, { name: "blog" }),
  include("/dashboard", dashboardPatterns, { name: "dashboard" }),
  include("/admin", adminPatterns, { name: "admin" }),
  include("/protected", protectedPatterns, { name: "protected" }),
  include("/todos", todosPatterns, { name: "todos" }),
  include("/errors", errorsPatterns, { name: "errors" }),
  include("/kanban", kanbanPatterns, { name: "kanban" }),
  include("/loaders", loadersPatterns, { name: "loaders" }),
  include("/middleware", middlewarePatterns, { name: "middleware" }),
  include("/shop", shopPatterns, { name: "shop" }),
  include("/magazine", magazinePatterns, { name: "magazine" }),

  // Unhandled error route - outside of any error boundary
  // (uses urls() directly since it has its own full path)
  include("", unhandledErrorPattern),
]);
