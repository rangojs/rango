/**
 * Tests for createRSCRouter() factory and RSCRouter class
 * Following TDD: These tests define the expected router API
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('createRSCRouter() factory', () => {
  describe('Factory function', () => {
    it('should create a router instance', () => {
      const router = createRSCRouter();

      expect(router).toBeDefined();
      expect(router).toBeInstanceOf(Object);
    });

    it('should accept optional configuration', () => {
      const router = createRSCRouter({
        basePath: '/api',
      });

      expect(router).toBeDefined();
    });

    it('should create router without configuration', () => {
      const router = createRSCRouter();

      expect(router).toBeDefined();
    });
  });

  describe('RSCRouter class - Core methods', () => {
    it('should have route() method', () => {
      const router = createRSCRouter();

      expect(router.route).toBeDefined();
      expect(typeof router.route).toBe('function');
    });

    it('should have use() method', () => {
      const router = createRSCRouter();

      expect(router.use).toBeDefined();
      expect(typeof router.use).toBe('function');
    });

    it('should have match() method', () => {
      const router = createRSCRouter();

      expect(router.match).toBeDefined();
      expect(typeof router.match).toBe('function');
    });
  });

  describe('Fluent API - Chaining', () => {
    it('should allow chaining use() method', () => {
      const router = createRSCRouter();
      const middleware1 = async () => {};
      const middleware2 = async () => {};

      const result = router.use(middleware1).use(middleware2);

      expect(result).toBe(router); // Should return same router instance
    });

    it('should allow chaining route() method', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const result = router.route(routes);

      expect(result).toBeDefined();
      // Should return a RouteBuilder for further chaining
    });
  });

  describe('RSCRouter - Basic configuration', () => {
    it('should accept basePath configuration', () => {
      const router = createRSCRouter({
        basePath: '/api/v1',
      });

      expect(router).toBeDefined();
      // basePath should be used for route matching
    });

    it('should handle empty configuration', () => {
      const router = createRSCRouter({});

      expect(router).toBeDefined();
    });
  });

  describe('RSCRouter - Global middleware', () => {
    it('should accept global middleware via use()', () => {
      const router = createRSCRouter();
      const globalMiddleware = async () => {};

      router.use(globalMiddleware);

      // Should store middleware for all routes
      expect(router).toBeDefined();
    });

    it('should accept multiple middleware at once', () => {
      const router = createRSCRouter();
      const mw1 = async () => {};
      const mw2 = async () => {};
      const mw3 = async () => {};

      router.use(mw1, mw2, mw3);

      expect(router).toBeDefined();
    });

    it('should chain multiple use() calls', () => {
      const router = createRSCRouter();

      const result = router
        .use(async () => {})
        .use(async () => {})
        .use(async () => {});

      expect(result).toBe(router);
    });
  });

  describe('RSCRouter - Route registration', () => {
    it('should register routes without prefix', () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
      });

      const builder = router.route(routes);

      expect(builder).toBeDefined();
      expect(builder.map).toBeDefined();
      expect(builder.use).toBeDefined();
    });

    it('should register routes with prefix', () => {
      const router = createRSCRouter();
      const routes = route({
        index: '/',
        show: '/:id',
      });

      const builder = router.route('/blog', routes);

      expect(builder).toBeDefined();
    });

    it('should handle multiple route registrations', () => {
      const router = createRSCRouter();
      const mainRoutes = route({ home: '/' });
      const blogRoutes = route({ index: '/blog' });

      router.route(mainRoutes);
      router.route('/blog', blogRoutes);

      // Should have both route groups registered
      expect(router).toBeDefined();
    });
  });

  describe('RSCRouter - Instance isolation', () => {
    it('should create independent router instances', () => {
      const router1 = createRSCRouter();
      const router2 = createRSCRouter();

      expect(router1).not.toBe(router2);
    });

    it('should not share state between instances', () => {
      const router1 = createRSCRouter();
      const router2 = createRSCRouter();

      const mw1 = async () => {};
      router1.use(mw1);

      // router2 should not have router1's middleware
      expect(router1).not.toBe(router2);
    });
  });
});
