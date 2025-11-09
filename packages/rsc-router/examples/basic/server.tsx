/**
 * Example: Server-Side Router Setup
 *
 * Demonstrates:
 * - Router creation
 * - Global middleware
 * - Route mounting with prefixes
 * - Layout configuration
 * - Parallel routes (@sidebar, @modal)
 * - Handler mapping
 */

import { createRSCRouter } from '../../src/create-router';
import { route } from '../../src/route-definition';
import { mainRoutes, blogRoutes, dashboardRoutes } from './routes';

// Example components
const RootLayout = () => <html><body><div>Root</div></body></html>;
const BlogLayout = () => <div className="blog-layout"><div>Blog Layout</div></div>;
const DashboardLayout = () => <div className="dashboard-layout"><div>Dashboard</div></div>;

const HomePage = () => <div>Home Page</div>;
const AboutPage = () => <div>About Page</div>;
const ContactPage = () => <div>Contact Page</div>;

const BlogIndex = () => <div>Blog Index</div>;
const BlogPost = ({ params }: { params: { slug: string } }) => (
  <div>Blog Post: {params.slug}</div>
);
const BlogCategory = ({ params }: { params: { category: string; slug: string } }) => (
  <div>
    Category: {params.category}, Post: {params.slug}
  </div>
);

const BlogSidebar = () => <aside>Blog Sidebar</aside>;
const BlogComments = () => <div>Comments Section</div>;

const DashboardMain = () => <div>Dashboard Main</div>;
const DashboardAnalytics = () => <div>Analytics</div>;
const DashboardSettings = () => <div>Settings</div>;
const DashboardProfile = () => <div>Profile</div>;

const DashboardSidebar = () => <aside>Dashboard Sidebar</aside>;
const NotificationPanel = () => <div>Notifications</div>;

// Example middleware
const logger = () => async (ctx: any, next: any) => {
  console.log(`→ ${ctx.pathname}`);
  await next();
};

const authMiddleware = () => async (ctx: any, next: any) => {
  // Check auth
  await next();
};

const blogMiddleware = () => async (ctx: any, next: any) => {
  console.log('Blog route accessed');
  await next();
};

const requireAuth = () => async (ctx: any, next: any) => {
  // Verify authenticated
  await next();
};

// Create router instance
const router = createRSCRouter();

// ============================================================================
// GLOBAL MIDDLEWARE
// ============================================================================

router
  .use(logger()) // Log all requests
  .use(authMiddleware()); // Check authentication

// ============================================================================
// MAIN ROUTES (Root Level)
// ============================================================================

router.route(mainRoutes).map({
  // Single layout for all main routes
  [route.layout]: RootLayout,

  home: () => <HomePage />,
  about: () => <AboutPage />,
  contact: () => <ContactPage />,
});

// ============================================================================
// BLOG ROUTES (/blog prefix)
// ============================================================================

router
  .route('/blog', blogRoutes)
  .use(blogMiddleware()) // Blog-specific middleware
  .map({
    // Array of nested layouts
    [route.layout]: [RootLayout, BlogLayout],

    // Global parallel routes for all blog routes
    [route.parallel]: {
      '@sidebar': () => <BlogSidebar />,
      '@comments': () => <BlogComments />,
    },

    // Route handlers
    index: () => <BlogIndex />,
    show: (ctx) => <BlogPost params={ctx.params} />,
    category: (ctx) => <BlogCategory params={ctx.params} />,
  });

// ============================================================================
// DASHBOARD ROUTES (/dashboard prefix)
// ============================================================================

router
  .route('/dashboard', dashboardRoutes)
  .use(requireAuth()) // Require authentication for dashboard
  .map({
    // Nested layouts
    [route.layout]: [RootLayout, DashboardLayout],

    // Per-route parallel routes (only on index)
    index: {
      [route.parallel]: {
        '@sidebar': () => <DashboardSidebar />,
        '@notifications': () => <NotificationPanel />,
      },
      handler: () => <DashboardMain />,
    },

    // Other routes without parallel routes
    analytics: () => <DashboardAnalytics />,
    settings: () => <DashboardSettings />,
    profile: () => <DashboardProfile />,
  });

export default router;
