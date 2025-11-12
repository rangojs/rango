/**
 * Tests for Layout Support - route.layout symbol
 * Following TDD: Tests define how layouts wrap route content
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Layout Support - route.layout', () => {
  describe('Single layout', () => {
    it('should accept layout via route.layout symbol', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const MyLayout = () => <div>Layout</div>;

      router.route(routes).map({
        [route.layout]: MyLayout,
        home: () => <div>Home</div>,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.[route.layout]).toBe(MyLayout);
    });

    it('should include layout in match result', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const MyLayout = () => <div>Layout</div>;

      router.route(routes).map({
        [route.layout]: MyLayout,
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('handlers');
      expect((result as any).handlers[route.layout]).toBe(MyLayout);
    });
  });

  describe('Layout with content', () => {
    it('should provide layout in handlers for rendering', async () => {
      const router = createRSCRouter();
      const routes = route({ page: '/page' });
      const PageLayout = () => <div>Layout</div>;
      const PageContent = () => <div>Content</div>;

      router.route(routes).map({
        [route.layout]: PageLayout,
        page: PageContent,
      });

      const result = await router.match(new Request('http://localhost/page'));

      expect((result as any).handlers[route.layout]).toBe(PageLayout);
      expect((result as any).handlers.page).toBe(PageContent);
    });
  });

  describe('Layout without layout (just content)', () => {
    it('should work without layout symbol', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect(result).not.toBeNull();
      expect((result as any).handlers[route.layout]).toBeUndefined();
    });
  });

  describe('Layout with nested routes', () => {
    it('should support layout in nested route handlers', async () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });
      const BlogLayout = () => <div>Blog Layout</div>;

      router.route(routes).map({
        blog: {
          [route.layout]: BlogLayout,
          index: () => <div>Blog Index</div>,
          post: () => <div>Blog Post</div>,
        },
      });

      const result = await router.match(new Request('http://localhost/blog'));

      expect(result).not.toBeNull();
    });
  });

  describe('Multiple routes with different layouts', () => {
    it('should support different layouts for different route groups', async () => {
      const router = createRSCRouter();
      const blogRoutes = route({ index: '/blog' });
      const adminRoutes = route({ dashboard: '/admin' });
      const BlogLayout = () => <div>Blog Layout</div>;
      const AdminLayout = () => <div>Admin Layout</div>;

      router.route(blogRoutes).map({
        [route.layout]: BlogLayout,
        index: () => <div>Blog</div>,
      });

      router.route(adminRoutes).map({
        [route.layout]: AdminLayout,
        dashboard: () => <div>Admin</div>,
      });

      const blogResult = await router.match(
        new Request('http://localhost/blog')
      );
      const adminResult = await router.match(
        new Request('http://localhost/admin')
      );

      expect((blogResult as any).handlers[route.layout]).toBe(BlogLayout);
      expect((adminResult as any).handlers[route.layout]).toBe(AdminLayout);
    });
  });

  describe('Layout with middleware', () => {
    it('should execute middleware before layout', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const executionOrder: string[] = [];
      const MyLayout = () => <div>Layout</div>;

      router.use(async (ctx, next) => {
        executionOrder.push('middleware');
        await next();
      });

      router.route(routes).map({
        [route.layout]: MyLayout,
        home: () => {
          executionOrder.push('handler');
          return <div>Home</div>;
        },
      });

      await router.match(new Request('http://localhost/'));

      // Middleware executes first, before any rendering
      expect(executionOrder[0]).toBe('middleware');
    });
  });

  describe('Layout function components', () => {
    it('should accept function components as layouts', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const Layout = ({ children }: { children?: React.ReactNode }) => (
        <div className="layout">{children}</div>
      );

      router.route(routes).map({
        [route.layout]: Layout,
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect((result as any).handlers[route.layout]).toBe(Layout);
    });

    it('should accept arrow function layouts', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const Layout = () => <div>Layout</div>;

      router.route(routes).map({
        [route.layout]: Layout,
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect((result as any).handlers[route.layout]).toBe(Layout);
    });
  });
});
