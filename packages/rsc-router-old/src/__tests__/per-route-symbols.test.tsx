/**
 * Tests for Per-Route Symbols - Different layouts/parallel routes per route
 * Following TDD: Tests define type-safe per-route configuration
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Per-Route Symbols - Type-safe per-route configuration', () => {
  describe('Per-route layouts', () => {
    it('should accept per-route layouts as object', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
      });
      const HomeLayout = () => <div>HomeLayout</div>;
      const AboutLayout = () => <div>AboutLayout</div>;

      router.route(routes).map({
        [route.layout]: {
          home: HomeLayout,
          about: AboutLayout,
        },
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      const homeResult = await router.match(new Request('http://localhost/'));
      const aboutResult = await router.match(
        new Request('http://localhost/about')
      );

      expect((homeResult as any).handlers[route.layout]).toHaveProperty(
        'home',
        HomeLayout
      );
      expect((aboutResult as any).handlers[route.layout]).toHaveProperty(
        'about',
        AboutLayout
      );
    });

    it('should support per-route layout arrays', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        dashboard: '/dashboard',
      });
      const Root = () => <div>Root</div>;
      const HomeShell = () => <div>HomeShell</div>;
      const DashboardShell = () => <div>DashboardShell</div>;

      router.route(routes).map({
        [route.layout]: {
          home: [Root, HomeShell],
          dashboard: [Root, DashboardShell],
        },
        home: () => <div>Home</div>,
        dashboard: () => <div>Dashboard</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toHaveProperty('home');
      expect(layouts.home).toEqual([Root, HomeShell]);
    });

    it('should allow some routes to omit layouts', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
        contact: '/contact',
      });
      const HomeLayout = () => <div>HomeLayout</div>;

      router.route(routes).map({
        [route.layout]: {
          home: HomeLayout,
          // about and contact omitted - no layout
        },
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
        contact: () => <div>Contact</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toHaveProperty('home', HomeLayout);
      expect(layouts).not.toHaveProperty('about');
      expect(layouts).not.toHaveProperty('contact');
    });
  });

  describe('Per-route parallel routes', () => {
    it('should accept per-route parallel routes as object', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        dashboard: '/dashboard',
      });

      router.route(routes).map({
        [route.parallel]: {
          home: {
            '@sidebar': () => <div>HomeSidebar</div>,
          },
          dashboard: {
            '@sidebar': () => <div>DashboardSidebar</div>,
            '@notifications': () => <div>Notifications</div>,
          },
        },
        home: () => <div>Home</div>,
        dashboard: () => <div>Dashboard</div>,
      });

      const homeResult = await router.match(new Request('http://localhost/'));
      const dashResult = await router.match(
        new Request('http://localhost/dashboard')
      );

      expect((homeResult as any).handlers[route.parallel]).toHaveProperty(
        'home'
      );
      expect((dashResult as any).handlers[route.parallel]).toHaveProperty(
        'dashboard'
      );
    });

    it('should allow routes to have no parallel routes', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
      });

      router.route(routes).map({
        [route.parallel]: {
          home: {
            '@sidebar': () => <div>Sidebar</div>,
          },
          // 'about' has no parallel routes
        },
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const parallel = (result as any).handlers[route.parallel];

      expect(parallel).toHaveProperty('home');
      expect(parallel).not.toHaveProperty('about');
    });
  });

  describe('Combined per-route layouts and parallel routes', () => {
    it('should support both per-route layouts and parallel routes', async () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        dashboard: '/dashboard',
      });

      router.route(routes).map({
        [route.layout]: {
          home: [() => <div>Root</div>, () => <div>HomeLayout</div>],
          dashboard: [() => <div>Root</div>, () => <div>DashLayout</div>],
        },
        [route.parallel]: {
          dashboard: {
            '@sidebar': () => <div>Sidebar</div>,
            '@notifications': () => <div>Notifications</div>,
          },
        },
        home: () => <div>Home</div>,
        dashboard: () => <div>Dashboard</div>,
      });

      const result = await router.match(
        new Request('http://localhost/dashboard')
      );

      expect((result as any).handlers[route.layout]).toHaveProperty('dashboard');
      expect((result as any).handlers[route.parallel]).toHaveProperty(
        'dashboard'
      );
    });
  });

  describe('Per-route with nested routes', () => {
    it('should support per-route symbols in nested route handlers', async () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      router.route(routes).map({
        blog: {
          [route.layout]: {
            index: () => <div>IndexLayout</div>,
            post: () => <div>PostLayout</div>,
          },
          index: () => <div>Index</div>,
          post: () => <div>Post</div>,
        },
      });

      const result = await router.match(new Request('http://localhost/blog'));
      expect(result).not.toBeNull();
    });
  });

  describe('Backward compatibility', () => {
    it('should still support global layout (not per-route)', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/', about: '/about' });
      const GlobalLayout = () => <div>Global</div>;

      router.route(routes).map({
        [route.layout]: GlobalLayout,  // Single layout for all
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      // Should not be an object with route names
      expect((result as any).handlers[route.layout]).toBe(GlobalLayout);
    });

    it('should still support global parallel routes', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes).map({
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
        },
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      // Should have @sidebar key directly
      expect((result as any).handlers[route.parallel]).toHaveProperty(
        '@sidebar'
      );
    });
  });
});
