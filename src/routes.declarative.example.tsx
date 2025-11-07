/**
 * Example of using the new declarative router API
 * This file demonstrates the proposed Router API from the ideas document
 */

import {
  createRouter,
  route,
  middleware,
  layout,
  revalidate,
  loading,
  type RouteContext,
} from "rsc-router";

// Import layouts
import RootLayout from "./layouts/RootLayout";
import DashboardLayout from "./layouts/DashboardLayout";
import ArticlesLayout from "./layouts/ArticlesLayout";

// Import pages
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import DashboardAnalyticsPage from "./pages/DashboardAnalyticsPage";
import ArticlesListPage from "./pages/ArticlesListPage";

// ==========================================
// Step 1: Define route structure declaratively
// ==========================================

// Define main routes
const routesMain = route({
  home: "/",
  about: "/about",
});

// Define dashboard routes
const routesDashboard = route({
  index: "/",
  analytics: "/analytics",
  settings: "/settings",
});

// Define articles routes
const routesArticles = route({
  index: "/",
  show: "/:id",
});

// Compose all routes together
const routes = route(routesMain, {
  dashboard: routesDashboard,
  articles: routesArticles,
});

// TypeScript now knows the exact shape of our routes!
// type Routes = typeof routes;
// The Routes type shows the structure:
// {
//   home: string
//   about: string
//   dashboard: {
//     index: string
//     analytics: string
//     settings: string
//   }
//   articles: {
//     index: string
//     show: string  // with :id param
//   }
// }

// ==========================================
// Step 2: Create router with global middleware
// ==========================================

const router = createRouter(routes, {
  // Global middleware that runs for all routes
  [middleware]: [
    async (ctx, next) => {
      console.log(`[Global Middleware] Request to: ${ctx.pathname}`);
      await next();
    },
  ],
  // Could also add a global layout here
  // [layout]: RootLayout,
});

// ==========================================
// Step 3: Map handlers to routes (with type safety!)
// ==========================================

// Map main routes
router.map(routesMain, {
  // Root layout for all routes
  [layout]: RootLayout,

  // Simple route handlers
  home: async () => <HomePage />,

  about: async () => (
    <div>
      <h1>About Us</h1>
      <p>This is a simple page that only uses the root layout.</p>
      <p>
        When navigating here from Dashboard or Articles, those layouts unmount.
      </p>
    </div>
  ),
});

// Map dashboard routes (can be in a separate file!)
router.map(routesDashboard, {
  // Dashboard-specific layout
  [layout]: DashboardLayout,

  // Dashboard-specific middleware
  [middleware]: [
    async (ctx: RouteContext, next: () => Promise<void>) => {
      console.log(`[Dashboard Auth] Checking permissions...`);
      // Add auth checks here
      await next();
    },
  ],

  // Route handlers
  index: async () => <DashboardPage />,
  analytics: async () => <DashboardAnalyticsPage />,
  settings: async () => (
    <div>
      <h2>Settings</h2>
      <p>Manage your dashboard settings here.</p>
      <form>
        <label>
          Theme:
          <select>
            <option>Light</option>
            <option>Dark</option>
          </select>
        </label>
      </form>
    </div>
  ),
});

// Map articles routes (with advanced features!)
router.map(routesArticles, {
  // Articles layout
  [layout]: ArticlesLayout,

  // Fine-grained revalidation control
  [revalidate]: {
    // Only revalidate the 'show' route when the article ID changes
    show: (ctx: any) => {
      // TypeScript knows ctx has currentPath, nextPath, params, etc.
      return ctx.params.id !== ctx.actionParams?.id;
    },
    // Articles list always revalidates
    index: () => true,
  },

  // Loading states (not implemented in current router)
  [loading]: {
    show: () => <div>Loading article...</div>,
  },

  // Route handlers with type-safe params!
  index: async () => <ArticlesListPage />,

  show: async (ctx: RouteContext) => {
    // With proper type inference, TypeScript would know ctx.params.id exists
    const { id } = ctx.params;
    const MyTestPage = (await import("./MyTestPage")).MyTestPage;

    return (
      <article>
        <h2>Article {id}</h2>
        <MyTestPage />
        <p>This is article #{id}. The URL param was extracted from the route.</p>
        <p>
          Notice how the Articles layout is preserved when navigating between
          articles, but changes when going to Dashboard or Home.
        </p>
        <a href="/articles">← Back to articles</a>
      </article>
    );
  },
});

// ==========================================
// Step 4: Handle 404s
// ==========================================

// This would need special handling in the declarative API
// For now, you could add it to the imperative router directly
// or define a catch-all route in the route map

// ==========================================
// Alternative: Lazy loading handlers
// ==========================================

// You can also lazy load entire handler modules!
// This is great for code splitting in large apps

// router.map(routesArticles, () => import("./handlers/articles.handlers"));

// In ./handlers/articles.handlers.ts:
// export default {
//   [layout]: ArticlesLayout,
//   [revalidate]: { ... },
//   index: async () => <ArticlesListPage />,
//   show: async (ctx) => <ArticleDetailPage id={ctx.params.id} />,
// };

// ==========================================
// Benefits of this approach:
// ==========================================

/**
 * 1. Type Safety:
 *    - Route parameters are typed (ctx.params.id is known to exist)
 *    - Handler structure must match route structure
 *    - Compile-time validation of route names
 *
 * 2. Modularity:
 *    - Routes can be defined in separate files
 *    - Handlers can be lazy loaded
 *    - Easy to split by feature/team
 *
 * 3. Declarative:
 *    - Route structure is data, not code
 *    - Easy to visualize and reason about
 *    - Can be generated/modified programmatically
 *
 * 4. Metadata:
 *    - Layouts, middleware, revalidation are explicit
 *    - Not mixed with route handlers
 *    - Clear separation of concerns
 *
 * 5. Revalidation Control:
 *    - Fine-grained control per route
 *    - Access to navigation context
 *    - Can optimize partial rendering
 */

export default router;