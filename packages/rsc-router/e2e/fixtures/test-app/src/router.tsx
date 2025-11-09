/**
 * E2E Test App - Router Configuration
 */

import { createRSCRouter } from '../../../../src/create-router';
import { route } from '../../../../src/route-definition';
import { Outlet } from '../../../../src/Outlet';

// Routes
export const routes = route({
  home: '/',
  about: '/about',
  blog: {
    index: '/blog',
    post: '/blog/:slug',
  },
  dashboard: '/dashboard',
});

// Components
const RootLayout = () => (
  <html>
    <body>
      <nav>
        <a href="/">Home</a> | <a href="/about">About</a> | <a href="/blog">Blog</a> | <a href="/dashboard">Dashboard</a>
      </nav>
      <main>
        <Outlet />
      </main>
    </body>
  </html>
);

const HomePage = () => <div data-testid="home-page">Home Page</div>;
const AboutPage = () => <div data-testid="about-page">About Page</div>;
const BlogIndex = () => <div data-testid="blog-index">Blog Index</div>;
const BlogPost = ({ params }: { params: { slug: string } }) => (
  <div data-testid="blog-post">Blog Post: {params.slug}</div>
);
const DashboardPage = () => <div data-testid="dashboard-page">Dashboard</div>;

// Create router
const router = createRSCRouter();

router.route(routes).map({
  [route.layout]: RootLayout,
  home: () => <HomePage />,
  about: () => <AboutPage />,
  blog: {
    index: () => <BlogIndex />,
    post: (ctx) => <BlogPost params={ctx.params} />,
  },
  dashboard: () => <DashboardPage />,
});

export default router;
