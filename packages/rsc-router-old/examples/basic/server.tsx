/**
 * Example: Enhanced Server-Side Router Setup
 *
 * Comprehensive demonstration of ALL RSC Router features:
 * - Multiple route groups
 * - Nested layouts (array layouts)
 * - Parallel routes (@sidebar, @modal, @notifications)
 * - Loading and error boundaries
 * - Global and route-specific middleware
 * - Dynamic routes with params
 * - Optional params
 * - Wildcard routes
 * - Lazy handler imports
 */

import { createRSCRouter } from '../../src/create-router';
import { Outlet } from '../../src/Outlet';
import { route } from '../../src/route-definition';
import { mainRoutes, blogRoutes, dashboardRoutes, apiRoutes } from './routes';

// ============================================================================
// LAYOUT COMPONENTS (with Outlet for nesting)
// ============================================================================

const RootLayout = () => (
  <html lang="en">
    <head>
      <meta charSet="UTF-8" />
      <title>RSC Router Example</title>
      <style>{`
        body { font-family: system-ui; margin: 0; padding: 20px; }
        nav { background: #f0f0f0; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
        nav a { margin-right: 15px; text-decoration: none; color: #0066cc; }
        nav a:hover { text-decoration: underline; }
        main { padding: 20px; }
        .sidebar { background: #f9f9f9; padding: 15px; border-left: 3px solid #0066cc; margin-top: 20px; }
        .notification { background: #fff3cd; padding: 10px; margin: 10px 0; border-radius: 4px; }
        .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: white; padding: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
      `}</style>
    </head>
    <body>
      <header>
        <h1>🚀 RSC Router - Complete Example</h1>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/features">Features</a>
          <a href="/contact">Contact</a>
          <a href="/blog">Blog</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/api/health">API</a>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer style={{ marginTop: '40px', padding: '20px', background: '#f0f0f0', textAlign: 'center' }}>
        <p>RSC Router Example - Demonstrating all features</p>
      </footer>
    </body>
  </html>
);

const BlogLayout = () => (
  <div className="blog-container">
    <div style={{ display: 'flex', gap: '20px' }}>
      <div style={{ flex: 1 }}>
        <h2>📝 Blog</h2>
        <Outlet />
      </div>
    </div>
  </div>
);

const DashboardLayout = () => (
  <div className="dashboard-container">
    <h2>📊 Dashboard</h2>
    <nav style={{ background: '#e3f2fd', padding: '10px', marginBottom: '15px' }}>
      <a href="/dashboard">Overview</a> |{' '}
      <a href="/dashboard/analytics">Analytics</a> |{' '}
      <a href="/dashboard/settings">Settings</a> |{' '}
      <a href="/dashboard/users">Users</a>
    </nav>
    <Outlet />
  </div>
);

// ============================================================================
// PAGE COMPONENTS
// ============================================================================

const HomePage = () => (
  <div>
    <h2>Welcome Home!</h2>
    <p>This example demonstrates all RSC Router features:</p>
    <ul>
      <li>✅ Type-safe routes with <code>route()</code></li>
      <li>✅ Nested layouts with <code>[route.layout]</code></li>
      <li>✅ Parallel routes with <code>[route.parallel]</code></li>
      <li>✅ Middleware (global and route-specific)</li>
      <li>✅ Dynamic routes with params</li>
      <li>✅ Optional params</li>
      <li>✅ Wildcard routes</li>
      <li>✅ Loading and error boundaries</li>
      <li>✅ Partial rendering (SPA navigation)</li>
    </ul>
  </div>
);

const AboutPage = () => (
  <div>
    <h2>About</h2>
    <p>This is a comprehensive example showing all router features working together.</p>
  </div>
);

const FeaturesPage = () => (
  <div>
    <h2>Features</h2>
    <h3>Core Features:</h3>
    <ul>
      <li><strong>Partial Rendering</strong> - Only changed segments sent on navigation</li>
      <li><strong>SPA Navigation</strong> - Links don't reload the page</li>
      <li><strong>Parallel Routes</strong> - Multiple components render alongside main content</li>
      <li><strong>Nested Layouts</strong> - Layouts wrap layouts for complex UIs</li>
      <li><strong>Middleware</strong> - Authentication, logging, etc.</li>
    </ul>
  </div>
);

const ContactPage = () => <div><h2>Contact</h2><p>Get in touch with us.</p></div>;

// Blog components
const BlogIndex = () => (
  <div>
    <h3>Blog Posts</h3>
    <ul>
      <li><a href="/blog/hello-world">Hello World</a></li>
      <li><a href="/blog/getting-started">Getting Started</a></li>
      <li><a href="/blog/tech/react-tips">React Tips (Category)</a></li>
      <li><a href="/blog/archive/2024/11">Archive (Optional Params)</a></li>
    </ul>
  </div>
);

const BlogPost = ({ params }: { params: { slug: string } }) => (
  <article>
    <h3>📄 Blog Post: {params.slug}</h3>
    <p>This is the content for the blog post "{params.slug}".</p>
    <p>Notice how the sidebar and comments render alongside this content (parallel routes)!</p>
  </article>
);

const BlogCategory = ({ params }: { params: { category: string; slug: string } }) => (
  <article>
    <h3>📁 {params.category} / {params.slug}</h3>
    <p>This post is in the "{params.category}" category.</p>
  </article>
);

const BlogArchive = ({ params }: { params: { year?: string; month?: string } }) => (
  <div>
    <h3>📅 Archive</h3>
    <p>Year: {params.year || 'All'}</p>
    <p>Month: {params.month || 'All'}</p>
    <p>This demonstrates optional params!</p>
  </div>
);

// Parallel route components (render ALONGSIDE main content)
const BlogSidebar = () => (
  <aside className="sidebar">
    <h4>📌 Sidebar</h4>
    <p>This is a parallel route (@sidebar)</p>
    <ul>
      <li>Recent Posts</li>
      <li>Categories</li>
      <li>Tags</li>
    </ul>
  </aside>
);

const BlogComments = () => (
  <div className="sidebar">
    <h4>💬 Comments</h4>
    <p>This is another parallel route (@comments)</p>
    <p>Both sidebar and comments render alongside the main post!</p>
  </div>
);

// Dashboard components
const DashboardMain = () => (
  <div>
    <h3>Dashboard Overview</h3>
    <p>Welcome to your dashboard!</p>
    <p>Notice the sidebar and notifications rendering alongside this content.</p>
  </div>
);

const DashboardAnalytics = () => (
  <div>
    <h3>📈 Analytics</h3>
    <p>Analytics data would go here.</p>
  </div>
);

const DashboardSettings = () => (
  <div>
    <h3>⚙️ Settings</h3>
    <p>User settings and preferences.</p>
  </div>
);

const UserList = () => (
  <div>
    <h3>👥 Users</h3>
    <ul>
      <li><a href="/dashboard/users/1">User 1</a></li>
      <li><a href="/dashboard/users/2">User 2</a></li>
      <li><a href="/dashboard/users/3">User 3</a></li>
    </ul>
  </div>
);

const UserDetail = ({ params }: { params: { id: string } }) => (
  <div>
    <h3>User #{params.id}</h3>
    <p>User details for ID: {params.id}</p>
    <a href={`/dashboard/users/${params.id}/edit`}>Edit User</a>
  </div>
);

const UserEdit = ({ params }: { params: { id: string } }) => (
  <div>
    <h3>Edit User #{params.id}</h3>
    <p>Edit form for user {params.id}</p>
  </div>
);

// Dashboard parallel routes
const DashboardSidebar = () => (
  <aside className="sidebar">
    <h4>📊 Dashboard Sidebar</h4>
    <ul>
      <li>Quick Stats</li>
      <li>Recent Activity</li>
      <li>Shortcuts</li>
    </ul>
  </aside>
);

const NotificationPanel = () => (
  <div className="notification">
    <h4>🔔 Notifications</h4>
    <p>You have 3 new notifications</p>
  </div>
);

// Loading and Error components
const GlobalLoading = () => <div>⏳ Loading...</div>;
const GlobalError = ({ error }: { error?: Error }) => (
  <div style={{ color: 'red' }}>
    <h3>❌ Error</h3>
    <p>{error?.message || 'Something went wrong'}</p>
  </div>
);

const BlogLoading = () => <div>📝 Loading blog...</div>;
const BlogError = ({ error }: { error?: Error }) => (
  <div style={{ color: 'red' }}>
    <h4>Blog Error</h4>
    <p>{error?.message}</p>
  </div>
);

// API components
const ApiHealth = () => <div>{{ status: 'ok', timestamp: new Date().toISOString() }}</div>;
const ApiFiles = ({ params }: { params: { '*': string } }) => (
  <div>
    <h3>File Handler</h3>
    <p>Wildcard path: {params['*']}</p>
  </div>
);

// ============================================================================
// MIDDLEWARE
// ============================================================================

const logger = () => async (ctx: any, next: any) => {
  console.log(`→ ${ctx.pathname}`);
  await next();
};

const authMiddleware = () => async (ctx: any, next: any) => {
  // Check auth
  await next();
};

const blogMiddleware = () => async (ctx: any, next: any) => {
  console.log('📝 Blog route accessed');
  await next();
};

const dashboardAuth = () => async (ctx: any, next: any) => {
  console.log('🔐 Dashboard auth check');
  // In production, verify authentication here
  await next();
};

const apiCors = () => async (ctx: any, next: any) => {
  console.log('🌐 CORS middleware');
  await next();
};

// ============================================================================
// ROUTER CONFIGURATION
// ============================================================================

const router = createRSCRouter();

// Global middleware
router
  .use(logger())
  .use(authMiddleware());

// ============================================================================
// MAIN ROUTES
// ============================================================================

router.route(mainRoutes).map({
  [route.layout]: RootLayout,
  [route.loading]: GlobalLoading,
  [route.error]: GlobalError,

  home: () => <HomePage />,
  about: () => <AboutPage />,
  features: () => <FeaturesPage />,
  contact: () => <ContactPage />,
});

// ============================================================================
// BLOG ROUTES - Nested Layouts + Parallel Routes
// ============================================================================

router
  .route('/blog', blogRoutes)
  .use(blogMiddleware())
  .map({
    // Array of nested layouts
    [route.layout]: [RootLayout, BlogLayout],

    // Loading and error boundaries for blog
    [route.loading]: BlogLoading,
    [route.error]: BlogError,

    // Global parallel routes for ALL blog routes
    [route.parallel]: {
      '@sidebar': () => <BlogSidebar />,
      '@comments': () => <BlogComments />,
    },

    // Route handlers
    index: () => <BlogIndex />,
    show: (ctx) => <BlogPost params={ctx.params} />,
    category: (ctx) => <BlogCategory params={ctx.params} />,
    archive: (ctx) => <BlogArchive params={ctx.params} />,
  });

// ============================================================================
// DASHBOARD ROUTES - Per-Route Parallel Routes
// ============================================================================

router
  .route('/dashboard', dashboardRoutes)
  .use(dashboardAuth())
  .map({
    // Nested layouts
    [route.layout]: [RootLayout, DashboardLayout],

    // Dashboard overview with parallel routes
    index: {
      [route.parallel]: {
        '@sidebar': () => <DashboardSidebar />,
        '@notifications': () => <NotificationPanel />,
      },
      handler: () => <DashboardMain />,
    },

    // Other dashboard routes (no parallel routes)
    analytics: () => <DashboardAnalytics />,
    settings: () => <DashboardSettings />,

    // Nested user routes
    users: {
      list: () => <UserList />,
      detail: (ctx) => <UserDetail params={ctx.params} />,
      edit: (ctx) => <UserEdit params={ctx.params} />,
    },
  });

// ============================================================================
// API ROUTES - JSON Responses
// ============================================================================

router
  .route('/api', apiRoutes)
  .use(apiCors())
  .map({
    health: () => Response.json({ status: 'ok', timestamp: Date.now() }),
    files: (ctx) => Response.json({ path: ctx.params['*'] }),
  });

export default router;
