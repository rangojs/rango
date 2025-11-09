/**
 * Tests for route mounting and internal storage
 * Following TDD: Tests define how routes are stored and accessed internally
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('router.route() - Route mounting and storage', () => {
  describe('Route storage - No prefix', () => {
    it('should store simple routes without prefix', () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
      });

      router.route(routes);

      // Should have internal storage accessible for testing
      const registered = router.getRegisteredRoutes();
      expect(registered).toBeDefined();
      expect(registered.length).toBe(1);
    });

    it('should store route paths correctly', () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
        user: '/users/:id',
      });

      router.route(routes);

      const registered = router.getRegisteredRoutes();
      const paths = registered[0]?.routes.getAllPaths();

      expect(paths).toContain('/');
      expect(paths).toContain('/about');
      expect(paths).toContain('/users/:id');
    });
  });

  describe('Route storage - With prefix', () => {
    it('should store routes with prefix', () => {
      const router = createRSCRouter();
      const routes = route({
        index: '/',
        show: '/:id',
      });

      router.route('/blog', routes);

      const registered = router.getRegisteredRoutes();
      expect(registered.length).toBe(1);
      expect(registered[0]?.prefix).toBe('/blog');
    });

    it('should normalize prefix (remove trailing slash)', () => {
      const router = createRSCRouter();
      const routes = route({ index: '/' });

      router.route('/blog/', routes);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBe('/blog');
    });

    it('should handle empty string prefix as root', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route('', routes);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBeUndefined();
    });

    it('should handle / prefix as root', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route('/', routes);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBeUndefined();
    });
  });

  describe('Multiple route registrations', () => {
    it('should store multiple route groups', () => {
      const router = createRSCRouter();
      const mainRoutes = route({ home: '/' });
      const blogRoutes = route({ index: '/blog' });
      const adminRoutes = route({ dashboard: '/admin' });

      router.route(mainRoutes);
      router.route('/blog', blogRoutes);
      router.route('/admin', adminRoutes);

      const registered = router.getRegisteredRoutes();
      expect(registered.length).toBe(3);
    });

    it('should maintain registration order', () => {
      const router = createRSCRouter();
      const routes1 = route({ a: '/a' });
      const routes2 = route({ b: '/b' });
      const routes3 = route({ c: '/c' });

      router.route(routes1);
      router.route(routes2);
      router.route(routes3);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.routes.getAllPaths()).toContain('/a');
      expect(registered[1]?.routes.getAllPaths()).toContain('/b');
      expect(registered[2]?.routes.getAllPaths()).toContain('/c');
    });
  });

  describe('Nested route registration', () => {
    it('should store nested routes correctly', () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      router.route(routes);

      const registered = router.getRegisteredRoutes();
      expect(registered.length).toBe(1);
    });

    it('should flatten nested routes for storage', () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
        admin: {
          users: {
            list: '/admin/users',
            detail: '/admin/users/:id',
          },
        },
      });

      router.route(routes);

      const registered = router.getRegisteredRoutes();
      const allPaths = registered[0]?.routes.getAllPaths();

      expect(allPaths).toContain('/blog');
      expect(allPaths).toContain('/blog/:slug');
      expect(allPaths).toContain('/admin/users');
      expect(allPaths).toContain('/admin/users/:id');
    });
  });

  describe('Route with prefix and nested structure', () => {
    it('should combine prefix with nested routes', () => {
      const router = createRSCRouter();
      const routes = route({
        products: {
          list: '/products',
          detail: '/products/:id',
        },
      });

      router.route('/shop', routes);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBe('/shop');
      // Paths remain as defined (prefix applied during matching)
      const allPaths = registered[0]?.routes.getAllPaths();
      expect(allPaths).toContain('/products');
      expect(allPaths).toContain('/products/:id');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty route map', () => {
      const router = createRSCRouter();
      const routes = route({});

      router.route(routes);

      const registered = router.getRegisteredRoutes();
      expect(registered.length).toBe(1);
      expect(registered[0]?.routes.getAllPaths()).toEqual([]);
    });

    it('should handle duplicate path registration', () => {
      const router = createRSCRouter();
      const routes1 = route({ home: '/' });
      const routes2 = route({ index: '/' });

      router.route(routes1);
      router.route(routes2);

      const registered = router.getRegisteredRoutes();
      expect(registered.length).toBe(2);
      // Both should be stored (conflict resolution happens at match time)
    });
  });
});
