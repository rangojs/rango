import { RscRouter } from "rsc-router";

// Import layouts
import RootLayout from "./layouts/RootLayout";
import DashboardLayout from "./layouts/DashboardLayout";
import ArticlesLayout from "./layouts/ArticlesLayout";

// Import pages
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import DashboardAnalyticsPage from "./pages/DashboardAnalyticsPage";
import ArticlesListPage from "./pages/ArticlesListPage";

// Create router instance
export const router = new RscRouter();

const appRoute = route({
  index: "/",
  about: "/about",
});
const dashboardRoute = route({
  index: "/",
  analytics: "/analytics",
});
const articlesRoute = route({
  index: "/",
  details: "/:id",
});

// Global middleware example
router.use(async (ctx, next) => {
  console.log(`[Middleware] Request to: ${ctx.pathname}`);
  // Add any auth checks, logging, etc. here
  await next();
});

// Home page
router.get("/", async (ctx) => {
  return <HomePage />;
});

// Dashboard pages
router.get("/dashboard", async (ctx) => {
  return <DashboardPage />;
});

router.get("/dashboard/analytics", async (ctx) => {
  return <DashboardAnalyticsPage />;
});

router.get("/dashboard/settings", async (ctx) => {
  return (
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
  );
});

// Articles pages
router.get("/articles", async (ctx) => {
  return <ArticlesListPage />;
});

router.get("/articles/:id", async (ctx) => {
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
});

// Simple about page
router.get("/about", async (ctx) => {
  return (
    <div>
      <h1>About Us</h1>
      <p>This is a simple page that only uses the root layout.</p>
      <p>
        When navigating here from Dashboard or Articles, those layouts unmount.
      </p>
    </div>
  );
});

// 404 handler
router.all("*", async (ctx) => {
  return (
    <div>
      <h1>404 - Not Found</h1>
      <p>The page {ctx.pathname} was not found.</p>
      <a href="/">Go home</a>
    </div>
  );
});
