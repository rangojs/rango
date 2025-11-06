import { RscRouter } from './framework/router/router.tsx';

// Import layouts
import RootLayout from './layouts/RootLayout';
import DashboardLayout from './layouts/DashboardLayout';
import ArticlesLayout from './layouts/ArticlesLayout';

// Import pages
import HomePage from './pages/HomePage';
import DashboardPage from './pages/DashboardPage';
import DashboardAnalyticsPage from './pages/DashboardAnalyticsPage';
import ArticlesListPage from './pages/ArticlesListPage';

// Create router instance
export const router = new RscRouter();

// Global middleware example
router.use(async (ctx, next) => {
  console.log(`[Middleware] Request to: ${ctx.pathname}`);
  // Add any auth checks, logging, etc. here
  await next();
});

// Root layout - wraps everything
router.layout('/', async (ctx, children) => {
  return <RootLayout />;
});

// Home page
router.get('/', async (ctx) => {
  return <HomePage />;
});

// Dashboard layout group
router.layout('/dashboard', async (ctx, children) => {
  return <DashboardLayout />;
});

// Dashboard pages
router.get('/dashboard', async (ctx) => {
  return <DashboardPage />;
});

router.get('/dashboard/analytics', async (ctx) => {
  return <DashboardAnalyticsPage />;
});

router.get('/dashboard/settings', async (ctx) => {
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

router.endLayout(); // End dashboard layout group

// Articles layout group
router.layout('/articles', async (ctx, children) => {
  return <ArticlesLayout />;
});

router.get('/articles', async (ctx) => {
  return <ArticlesListPage />;
});

router.get('/articles/:id', async (ctx) => {
  const { id } = ctx.params;
  return (
    <article>
      <h2>Article {id}</h2>
      <p>This is article #{id}. The URL param was extracted from the route.</p>
      <p>
        Notice how the Articles layout is preserved when navigating between articles,
        but changes when going to Dashboard or Home.
      </p>
      <a href="/articles">← Back to articles</a>
    </article>
  );
});

router.endLayout(); // End articles layout group

// Simple about page (uses root layout only)
router.get('/about', async (ctx) => {
  return (
    <div>
      <h1>About Us</h1>
      <p>This is a simple page that only uses the root layout.</p>
      <p>When navigating here from Dashboard or Articles, those layouts unmount.</p>
    </div>
  );
});

router.endLayout(); // End root layout

// 404 handler (no layout)
router.all('*', async (ctx) => {
  return (
    <html>
      <body>
        <h1>404 - Not Found</h1>
        <p>The page {ctx.pathname} was not found.</p>
        <a href="/">Go home</a>
      </body>
    </html>
  );
});